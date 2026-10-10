import { startTransition, useEffect, useRef, useState } from 'react';
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
 * Server heartbeats every ~8s (padded comment + `event: ping`). Treat longer
 * silence as a dead stream. Kept above 2–3 missed pings so LAN/STL jitter does
 * not flap LIVE, but well under the old 90s window that left UK tunnel clients
 * looking "LIVE" while frozen.
 */
const IDLE_TIMEOUT_MS = 40_000;
/**
 * Parsed SSE frames (including `ping`) must arrive within this window or we
 * force close + reconnect + snapshot refetch. Separates "TCP still open /
 * headers received" from "actually receiving the live view stream" — the UK
 * desync failure mode through cloudflared.
 */
const STALE_AFTER_MS = 25_000;
/** How often to check `lastEventAt` while a stream is open. */
const STALE_CHECK_MS = 5_000;
/** Show a sticky error only after several transient disconnects in a row. */
const STICKY_ERROR_AFTER_FAILURES = 3;
/** If the open stream has not delivered a state frame yet, fall back to GET view. */
const FIRST_STATE_FALLBACK_MS = 2_500;

function isTransientStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg === 'SSE idle timeout' ||
    msg === 'SSE stale timeout' ||
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
    let staleTimer: number | undefined;
    let abort: AbortController | undefined;
    /** Bumped on every new connect attempt so stale attempts never re-arm timers. */
    let generation = 0;
    let attempt = 0;
    let authInvalid = false;
    /** Last time we parsed a complete SSE event (`ping`, `state`, `connections`). */
    let lastEventAt = 0;
    /** When the current fetch stream became open (headers OK). */
    let streamOpenedAt = 0;
    /** True once headers+body stream is open; LIVE also requires a fresh event. */
    let streamOpen = false;

    const setConnectedState = (value: boolean) => {
      connectedRef.current = value;
      setConnected(value);
    };

    const publishConnected = () => {
      // Never show green LIVE for a zombie stream that opened but stopped
      // delivering pings/state (high-RTT cloudflared failure mode).
      const fresh = lastEventAt > 0 && Date.now() - lastEventAt < STALE_AFTER_MS;
      setConnectedState(streamOpen && fresh);
    };

    const clearReconnect = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const clearStaleWatch = () => {
      if (staleTimer !== undefined) {
        window.clearInterval(staleTimer);
        staleTimer = undefined;
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
        void openSse({ catchUp: true });
      }, delay + jitter);
    };

    const handleAuthInvalid = () => {
      authInvalid = true;
      clearReconnect();
      clearStaleWatch();
      streamOpen = false;
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
      if (
        err instanceof Error &&
        (err.message === 'SSE idle timeout' || err.message === 'SSE stale timeout')
      ) {
        setError('Connection interrupted — retrying…');
        return;
      }
      setError(err instanceof Error ? err.message : 'SSE disconnected');
    };

    const fullRefresh = async (signal?: AbortSignal) => {
      const data = await api.view(gameId, token, { signal });
      if (cancelled || signal?.aborted) return;
      lastVersionRef.current = data.stateVersion;
      // Snapshot catch-up is urgent — do not defer behind optics transitions.
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
      // SSE full-view payloads are large; apply as a transition so local optics
      // interaction (contact pick, compass, silhouette) stays urgent and is not
      // blocked behind remote tunnel delivery / React reconcile of the station tree.
      startTransition(() => {
        setStateVersion(stateVersionNext);
        setView(nextView);
      });
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

    const noteEvent = () => {
      lastEventAt = Date.now();
      publishConnected();
    };

    const forceStaleReconnect = (fromGeneration: number) => {
      if (cancelled || authInvalid || fromGeneration !== generation) return;
      streamOpen = false;
      publishConnected();
      attempt += 1;
      noteStreamFailure(new Error('SSE stale timeout'));
      try {
        abort?.abort();
      } catch {
        /* ignore */
      }
      // Immediate catch-up reconnect (no backoff) — UK players were stuck until
      // a full browser refresh; snapshot refetch runs inside openSse.
      void openSse({ catchUp: true });
    };

    const armStaleWatch = (fromGeneration: number) => {
      clearStaleWatch();
      staleTimer = window.setInterval(() => {
        if (cancelled || authInvalid || fromGeneration !== generation) return;
        if (document.visibilityState === 'hidden') return;
        if (!streamOpen) return;
        const now = Date.now();
        if (lastEventAt > 0) {
          if (now - lastEventAt < STALE_AFTER_MS) {
            publishConnected();
            return;
          }
          forceStaleReconnect(fromGeneration);
          return;
        }
        // Headers arrived but no parseable ping/state yet — same zombie path
        // (buffered/stalled tunnel) as a stream that went quiet later.
        if (streamOpenedAt > 0 && now - streamOpenedAt >= STALE_AFTER_MS) {
          forceStaleReconnect(fromGeneration);
        }
      }, STALE_CHECK_MS);
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

    const openSse = async (opts?: { catchUp?: boolean }) => {
      if (cancelled || authInvalid) return;

      clearReconnect();
      clearStaleWatch();
      abort?.abort();
      const myGeneration = ++generation;
      abort = new AbortController();
      const { signal } = abort;

      streamOpen = false;
      streamOpenedAt = 0;
      lastEventAt = 0;
      setConnectedState(false);

      const catchUp = opts?.catchUp === true || lastVersionRef.current > 0;

      try {
        // First paint: await snapshot so the station is not blank before SSE.
        // Reconnect / stale catch-up: refresh in parallel so we do not delay
        // opening the stream (and still recover if the tunnel SSE path is wedged).
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
        } else if (catchUp) {
          void fullRefresh(signal).catch((err) => {
            if (signal.aborted || cancelled || myGeneration !== generation) return;
            if (isAuthFailure(err)) handleAuthInvalid();
          });
        }

        // Token goes on the URL: native EventSource cannot set Authorization, and some
        // proxies drop Authorization on long-lived streams. Do not log this URL.
        const eventsUrl = `/api/games/${gameId}/events?token=${encodeURIComponent(token)}`;
        const res = await fetch(eventsUrl, {
          signal,
          cache: 'no-store',
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) {
          if (res.status === 401) {
            handleAuthInvalid();
            return;
          }
          throw new Error(`SSE failed (${res.status})`);
        }
        if (signal.aborted || cancelled || myGeneration !== generation) return;

        streamOpen = true;
        streamOpenedAt = Date.now();
        // Headers alone are not "connected" for LIVE — wait for a ping/state frame.
        publishConnected();
        setError(null);
        attempt = 0;
        armStaleWatch(myGeneration);

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
                // Count ping/state/connections — any parsed frame proves the
                // live path is delivering (not a zombie OPEN).
                noteEvent();
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

        streamOpen = false;
        clearStaleWatch();
        setConnectedState(false);
        attempt += 1;
        noteStreamFailure(new Error('SSE disconnected'));
        scheduleReconnect(myGeneration);
      } catch (err) {
        if (cancelled || signal.aborted || myGeneration !== generation || authInvalid) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;

        streamOpen = false;
        clearStaleWatch();
        setConnectedState(false);
        attempt += 1;
        noteStreamFailure(err);
        scheduleReconnect(myGeneration);
      }
    };

    const kickIfNeeded = () => {
      if (cancelled || authInvalid) return;
      if (document.visibilityState === 'hidden') return;
      // Tab visible / network back: if stream is down or stale, reconnect + catch up.
      if (!connectedRef.current) {
        attempt = 0;
        clearReconnect();
        void openSse({ catchUp: true });
      } else {
        void refreshRef.current();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') kickIfNeeded();
    };

    void openSse({ catchUp: false });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', kickIfNeeded);

    return () => {
      cancelled = true;
      generation += 1;
      clearReconnect();
      clearStaleWatch();
      abort?.abort();
      streamOpen = false;
      setConnectedState(false);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kickIfNeeded);
    };
  }, [gameId, token, enabled]);

  const refresh = () => refreshRef.current();

  return { view, stateVersion, connected, error, setView, refresh };
}
