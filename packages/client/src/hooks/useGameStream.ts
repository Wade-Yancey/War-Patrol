import { useEffect, useRef, useState } from 'react';
import type { ClientView } from '@war-patrol/shared';
import { api } from '../api/client';

interface Options {
  gameId: string;
  token: string | null;
  enabled?: boolean;
}

const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 12_000;
/** Server heartbeats every ~25s; treat longer silence as a dead stream. */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * SSE subscription with auto-reconnect and full refresh on version gaps (ARCH-SA-05–08).
 *
 * Important: aborted attempts must not schedule a second reconnect (that killed healthy
 * streams and left the LIVE indicator stuck on RECONNECTING).
 */
export function useGameStream({ gameId, token, enabled = true }: Options) {
  const [view, setView] = useState<ClientView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastVersionRef = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const connectedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !token || !gameId) return;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let abort: AbortController | undefined;
    /** Bumped on every new connect attempt so stale attempts never re-arm timers. */
    let generation = 0;
    let attempt = 0;

    const setConnectedState = (value: boolean) => {
      connectedRef.current = value;
      setConnected(value);
    };

    const clearReconnect = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const scheduleReconnect = (fromGeneration: number) => {
      if (cancelled || fromGeneration !== generation) return;
      clearReconnect();
      const exp = Math.min(attempt, 5);
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exp);
      const jitter = Math.floor(Math.random() * 300);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (cancelled || fromGeneration !== generation) return;
        void openSse();
      }, delay + jitter);
    };

    const fullRefresh = async (signal?: AbortSignal) => {
      const data = await api.view(gameId, token, { signal });
      if (cancelled || signal?.aborted) return;
      lastVersionRef.current = data.stateVersion;
      setStateVersion(data.stateVersion);
      setView(data.view);
      setError(null);
    };
    refreshRef.current = async () => {
      try {
        await fullRefresh(abort?.signal);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    };

    const readWithIdleTimeout = (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      signal: AbortSignal,
    ): Promise<ReadableStreamReadResult<Uint8Array>> =>
      new Promise((resolve, reject) => {
        let settled = false;
        let idle: number | undefined;

        const clearIdle = () => {
          if (idle !== undefined) {
            window.clearTimeout(idle);
            idle = undefined;
          }
        };

        const armIdle = () => {
          clearIdle();
          // Background tabs throttle timers/streams; don't treat that as a dead connection.
          if (document.visibilityState === 'hidden') return;
          idle = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            document.removeEventListener('visibilitychange', onVisibility);
            reject(new Error('SSE idle timeout'));
          }, IDLE_TIMEOUT_MS);
        };

        const onVisibility = () => {
          if (settled) return;
          armIdle();
        };

        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearIdle();
          document.removeEventListener('visibilitychange', onVisibility);
          reject(new DOMException('Aborted', 'AbortError'));
        };

        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        document.addEventListener('visibilitychange', onVisibility);
        armIdle();

        reader.read().then(
          (result) => {
            if (settled) return;
            settled = true;
            clearIdle();
            document.removeEventListener('visibilitychange', onVisibility);
            signal.removeEventListener('abort', onAbort);
            resolve(result);
          },
          (err: unknown) => {
            if (settled) return;
            settled = true;
            clearIdle();
            document.removeEventListener('visibilitychange', onVisibility);
            signal.removeEventListener('abort', onAbort);
            reject(err);
          },
        );
      });

    const openSse = async () => {
      if (cancelled) return;

      clearReconnect();
      abort?.abort();
      const myGeneration = ++generation;
      abort = new AbortController();
      const { signal } = abort;

      setConnectedState(false);

      try {
        // Prefer a quick snapshot before opening the stream; do not hang reconnect on it.
        try {
          await fullRefresh(signal);
        } catch (err) {
          if (signal.aborted || cancelled) return;
          // Continue — SSE open + post-connect resync still restore state.
          setError(err instanceof Error ? err.message : 'Refresh failed');
        }
        if (signal.aborted || cancelled || myGeneration !== generation) return;

        // Token goes on the URL: native EventSource cannot set Authorization, and some
        // proxies drop Authorization on long-lived streams. Do not log this URL.
        const eventsUrl = `/api/games/${gameId}/events?token=${encodeURIComponent(token)}`;
        const res = await fetch(eventsUrl, { signal });
        if (!res.ok || !res.body) {
          throw new Error(`SSE failed (${res.status})`);
        }
        if (signal.aborted || cancelled || myGeneration !== generation) return;

        setConnectedState(true);
        setError(null);
        attempt = 0;

        // ARCH-SA-07/08: after (re)connect, resync full state in case of version gaps.
        try {
          await fullRefresh(signal);
        } catch {
          /* stream payload will catch up when available */
        }
        if (signal.aborted || cancelled || myGeneration !== generation) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (!cancelled && !signal.aborted && myGeneration === generation) {
            const { done, value } = await readWithIdleTimeout(reader, signal);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const lines = chunk.split('\n');
              const dataLine = lines.find((l) => l.startsWith('data: '));
              if (!dataLine) continue;
              try {
                const payload = JSON.parse(dataLine.slice(6)) as {
                  type: string;
                  stateVersion: number;
                  view: ClientView;
                };
                if (payload.type !== 'state') continue;
                const prev = lastVersionRef.current;
                // Same version is OK (connection-count refresh without turn bump).
                if (prev > 0 && payload.stateVersion < prev) {
                  await fullRefresh(signal);
                  continue;
                }
                if (prev > 0 && payload.stateVersion > prev + 1) {
                  await fullRefresh(signal);
                  continue;
                }
                lastVersionRef.current = payload.stateVersion;
                setStateVersion(payload.stateVersion);
                setView(payload.view);
              } catch {
                /* ignore parse errors */
              }
            }
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }

        if (cancelled || signal.aborted || myGeneration !== generation) return;

        setConnectedState(false);
        setError('SSE disconnected');
        attempt += 1;
        scheduleReconnect(myGeneration);
      } catch (err) {
        if (cancelled || signal.aborted || myGeneration !== generation) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;

        setConnectedState(false);
        setError(err instanceof Error ? err.message : 'SSE disconnected');
        attempt += 1;
        scheduleReconnect(myGeneration);
      }
    };

    const kickIfNeeded = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') return;
      // Tab visible / network back: if stream is down, reconnect now; else soft-refresh.
      if (!connectedRef.current) {
        attempt = 0;
        clearReconnect();
        void openSse();
      } else {
        void refreshRef.current();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') kickIfNeeded();
    };

    void openSse();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', kickIfNeeded);

    return () => {
      cancelled = true;
      generation += 1;
      clearReconnect();
      abort?.abort();
      setConnectedState(false);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kickIfNeeded);
    };
  }, [gameId, token, enabled]);

  const refresh = () => refreshRef.current();

  return { view, stateVersion, connected, error, setView, refresh };
}
