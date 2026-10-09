import { useEffect, useRef, useState } from 'react';
import type { ClientView, UmpireView, VesselView } from '@war-patrol/shared';
import { api } from '../api/client';

interface Options {
  gameId: string;
  token: string | null;
  enabled?: boolean;
  /** Stale session (server restart / revoked) — clear storage and return to login. */
  onAuthInvalid?: () => void;
}

const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 12_000;
/**
 * Server heartbeats every ~15s (comment + `event: ping`). Treat longer silence
 * as a dead stream. Generous vs the ping interval so tablet timer jitter and a
 * missed frame do not flap the Controls LIVE indicator.
 */
const IDLE_TIMEOUT_MS = 90_000;
/** Show a sticky error only after several transient disconnects in a row. */
const STICKY_ERROR_AFTER_FAILURES = 3;
/** If the open stream has not delivered a state frame yet, fall back to GET view. */
const FIRST_STATE_FALLBACK_MS = 2_500;

function isTransientStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg === 'SSE idle timeout' ||
    msg === 'SSE disconnected' ||
    msg.startsWith('SSE failed (') ||
    msg === 'Failed to fetch' ||
    msg === 'network error' ||
    msg === 'NetworkError when attempting to fetch resource.'
  );
}

function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('unauthorized') ||
    msg.includes('invalid session') ||
    msg.includes('session required') ||
    msg.includes('admin token required') ||
    msg === 'sse failed (401)' ||
    msg.includes('401')
  );
}

/**
 * SSE subscription with auto-reconnect and full refresh on version gaps (ARCH-SA-05–08).
 *
 * Important: aborted attempts must not schedule a second reconnect (that killed healthy
 * streams and left the LIVE indicator stuck on RECONNECTING).
 */
export function useGameStream({ gameId, token, enabled = true, onAuthInvalid }: Options) {
  const [view, setView] = useState<ClientView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastVersionRef = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const connectedRef = useRef(false);
  const onAuthInvalidRef = useRef(onAuthInvalid);
  onAuthInvalidRef.current = onAuthInvalid;

  useEffect(() => {
    if (!enabled || !token || !gameId) return;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let abort: AbortController | undefined;
    /** Bumped on every new connect attempt so stale attempts never re-arm timers. */
    let generation = 0;
    let attempt = 0;
    let authInvalid = false;

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
      if (cancelled || authInvalid || fromGeneration !== generation) return;
      clearReconnect();
      const exp = Math.min(attempt, 5);
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exp);
      const jitter = Math.floor(Math.random() * 300);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (cancelled || authInvalid || fromGeneration !== generation) return;
        void openSse();
      }, delay + jitter);
    };

    const handleAuthInvalid = () => {
      authInvalid = true;
      clearReconnect();
      setConnectedState(false);
      setError('Session expired — sign in again');
      onAuthInvalidRef.current?.();
    };

    const noteStreamFailure = (err: unknown) => {
      if (isAuthFailure(err)) {
        handleAuthInvalid();
        return;
      }
      // LIVE/RECONNECTING already signals transient drops; keep Controls clean
      // unless the stream keeps failing (auth, hard network, etc.).
      if (isTransientStreamError(err) && attempt < STICKY_ERROR_AFTER_FAILURES) {
        setError(null);
        return;
      }
      if (err instanceof Error && err.message === 'SSE idle timeout') {
        setError('Connection interrupted — retrying…');
        return;
      }
      setError(err instanceof Error ? err.message : 'SSE disconnected');
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
        if (isAuthFailure(err)) {
          handleAuthInvalid();
          return;
        }
        setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    };

    const applyState = (stateVersionNext: number, nextView: ClientView) => {
      lastVersionRef.current = stateVersionNext;
      setStateVersion(stateVersionNext);
      setView(nextView);
    };

    const applyConnections = (payload: {
      stateVersion?: number;
      connections?: UmpireView['connections'];
      stationConnections?: VesselView['stationConnections'];
    }) => {
      setView((prev) => {
        if (!prev) return prev;
        if (prev.role === 'umpire' && payload.connections) {
          return { ...prev, connections: payload.connections };
        }
        if (prev.role === 'vessel' && payload.stationConnections) {
          return { ...prev, stationConnections: payload.stationConnections };
        }
        return prev;
      });
      if (typeof payload.stateVersion === 'number') {
        // Connection meta does not bump turn stateVersion; keep local marker in sync
        // only when the server echoes the current version.
        if (payload.stateVersion >= lastVersionRef.current) {
          lastVersionRef.current = payload.stateVersion;
          setStateVersion(payload.stateVersion);
        }
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
            try {
              void reader.cancel('SSE idle timeout');
            } catch {
              /* ignore */
            }
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
      if (cancelled || authInvalid) return;

      clearReconnect();
      abort?.abort();
      const myGeneration = ++generation;
      abort = new AbortController();
      const { signal } = abort;

      setConnectedState(false);

      try {
        // First paint only — reconnects rely on the stream's sendFull state frame
        // so we do not hammer GET /view (and delay reading) on every blip.
        if (lastVersionRef.current === 0) {
          try {
            await fullRefresh(signal);
          } catch (err) {
            if (signal.aborted || cancelled) return;
            if (isAuthFailure(err)) {
              handleAuthInvalid();
              return;
            }
            setError(err instanceof Error ? err.message : 'Refresh failed');
          }
          if (signal.aborted || cancelled || myGeneration !== generation) return;
        }

        // Token goes on the URL: native EventSource cannot set Authorization, and some
        // proxies drop Authorization on long-lived streams. Do not log this URL.
        const eventsUrl = `/api/games/${gameId}/events?token=${encodeURIComponent(token)}`;
        const res = await fetch(eventsUrl, { signal });
        if (!res.ok || !res.body) {
          if (res.status === 401) {
            handleAuthInvalid();
            return;
          }
          throw new Error(`SSE failed (${res.status})`);
        }
        if (signal.aborted || cancelled || myGeneration !== generation) return;

        setConnectedState(true);
        setError(null);
        attempt = 0;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawState = false;

        // Server sendFull should arrive immediately; only GET if the stream is quiet.
        const fallbackTimer = window.setTimeout(() => {
          if (cancelled || signal.aborted || myGeneration !== generation || sawState) return;
          void fullRefresh(signal).catch((err) => {
            if (isAuthFailure(err)) handleAuthInvalid();
          });
        }, FIRST_STATE_FALLBACK_MS);

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
                  stateVersion?: number;
                  view?: ClientView;
                  connections?: UmpireView['connections'];
                  stationConnections?: VesselView['stationConnections'];
                };
                if (payload.type === 'ping') continue;
                if (payload.type === 'connections') {
                  applyConnections(payload);
                  continue;
                }
                if (payload.type !== 'state' || payload.view == null || payload.stateVersion == null) {
                  continue;
                }
                sawState = true;
                // SSE state frames are full views — apply directly (including gaps /
                // rollbacks). Avoid a second GET /view that stalls remote Controls.
                applyState(payload.stateVersion, payload.view);
              } catch {
                /* ignore parse errors */
              }
            }
          }
        } finally {
          window.clearTimeout(fallbackTimer);
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }

        if (cancelled || signal.aborted || myGeneration !== generation || authInvalid) return;

        setConnectedState(false);
        attempt += 1;
        noteStreamFailure(new Error('SSE disconnected'));
        scheduleReconnect(myGeneration);
      } catch (err) {
        if (cancelled || signal.aborted || myGeneration !== generation || authInvalid) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;

        setConnectedState(false);
        attempt += 1;
        noteStreamFailure(err);
        scheduleReconnect(myGeneration);
      }
    };

    const kickIfNeeded = () => {
      if (cancelled || authInvalid) return;
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
