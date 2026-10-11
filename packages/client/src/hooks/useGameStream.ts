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
 * Server heartbeats every ~8s (padded comment + `event: ping` with
 * `stateVersion`). No readable bytes for this long → treat the fetch body as
 * dead. Kept **above** STALE_HARD_MS so the soft/hard stale watchdog owns
 * tunnel backpressure (large `state` delaying pings) instead of the idle
 * reader undercutting it at 40s and thrashing RECONNECTING (#254 follow-up).
 */
const IDLE_TIMEOUT_MS = 60_000;
/**
 * After this long without a parsed SSE frame, try one soft GET `/view` without
 * killing the stream. Large mid-turn `state` frames can backpressure cloudflared
 * so pings pause briefly — a hard reconnect here was the LIVE↔RECONNECTING
 * thrash (#248 / post-#250 / post-#254 Sensors-on-tunnel).
 */
const STALE_SOFT_MS = 25_000;
/**
 * Force close + reconnect only after this longer silence. Kept above the
 * server drain watchdog (~45s) so a wedged tunnel socket is dropped server-side
 * before we pile a second EventSource + sendFull onto the same pipe.
 */
const STALE_HARD_MS = 55_000;
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
  const onAuthInvalidRef = useRef(onAuthInvalid);
  onAuthInvalidRef.current = onAuthInvalid;

  useEffect(() => {
    if (!enabled || !token || !gameId) return;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let staleTimer: number | undefined;
    let abort: AbortController | undefined;
    /** Snapshot GETs — never share the SSE AbortSignal (optics soft polls / catch-up). */
    let snapshotAbort: AbortController | undefined;
    /** Coalesce concurrent GET /view (ping gap + optics soft poll + soft-stale). */
    let refreshInFlight: Promise<void> | null = null;
    /** Bumped on every new connect attempt so stale attempts never re-arm timers. */
    let generation = 0;
    let attempt = 0;
    let authInvalid = false;
    /** Last time we parsed a complete SSE event (`ping`, `state`, `connections`). */
    let lastEventAt = 0;
    /**
     * Last successful GET `/view`. Survives SSE reopen races so catch-up that
     * finishes before `streamOpen=true` still counts as LIVE proof (#254 gap).
     */
    let lastViewAt = 0;
    /** When the current fetch stream became open (headers OK). */
    let streamOpenedAt = 0;
    /** True once headers+body stream is open; LIVE also requires recent proof. */
    let streamOpen = false;
    /** One soft `/view` per soft-stale episode — avoid a 5s poll storm. */
    let softCatchUpAttempted = false;

    const setConnectedState = (value: boolean) => {
      setConnected(value);
    };

    const publishConnected = () => {
      // LIVE while the EventSource is open and we have recent proof of a usable
      // connection: parsed SSE (ping/state/connections) OR successful GET /view.
      // RECONNECTING only when the stream is truly down (!streamOpen) or proof
      // is older than the hard window — not during soft tunnel stalls where
      // `/view` / gameplay still work (#254 counted /view but still force-closed
      // at 25s of SSE silence).
      const proofAt = Math.max(lastEventAt, lastViewAt);
      const fresh = proofAt > 0 && Date.now() - proofAt < STALE_HARD_MS;
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

    /**
     * GET /view on a dedicated AbortController — never the SSE `abort` signal.
     * Optics soft polls (#250) and soft-stale catch-up must not share lifecycle
     * with EventSource reopen (that was the #248-class thrash amplifier).
     * Client-only: no server lastVersion hello / slim optics (#251/#252 stay out).
     */
    const snapshotRefresh = async () => {
      if (cancelled || authInvalid) return;
      if (refreshInFlight) {
        try {
          await refreshInFlight;
        } catch {
          /* coalesced caller notes errors */
        }
        return;
      }
      if (!snapshotAbort || snapshotAbort.signal.aborted) {
        snapshotAbort = new AbortController();
      }
      const { signal } = snapshotAbort;
      const run = (async () => {
        const data = await api.view(gameId, token, { signal });
        if (cancelled || signal.aborted) return;
        lastVersionRef.current = data.stateVersion;
        // Snapshot catch-up is urgent — do not defer behind optics transitions.
        setStateVersion(data.stateVersion);
        setView(data.view);
        setError(null);
        // Successful HTTP snapshot proves the origin is reachable. Always
        // record view proof (even if SSE headers have not landed yet) so
        // reconnect catch-up that races ahead of streamOpen still clears LIVE
        // once open. While the stream is open, also refresh lastEventAt so a
        // soft `/view` that keeps gameplay usable does not hard-kill SSE at 55s.
        const now = Date.now();
        lastViewAt = now;
        if (streamOpen) lastEventAt = now;
        softCatchUpAttempted = false;
        publishConnected();
      })();
      refreshInFlight = run.finally(() => {
        if (refreshInFlight === run) refreshInFlight = null;
      });
      try {
        await refreshInFlight;
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (isAuthFailure(err)) {
          handleAuthInvalid();
          return;
        }
        setError(err instanceof Error ? err.message : 'Refresh failed');
      }
    };

    refreshRef.current = () => snapshotRefresh();

    const applyState = (stateVersionNext: number, nextView: ClientView) => {
      lastVersionRef.current = stateVersionNext;
      // Apply urgently — mid-turn FoW (DD lookout feather on peri raise/lower)
      // must land without waiting on a transition. Optics chrome stays snappy via
      // StationPage `useDeferredValue` + local-first mast overlay (#235), not by
      // deferring the whole vessel view (that left tunnel remotes stale until F5).
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

    const noteEvent = () => {
      lastEventAt = Date.now();
      softCatchUpAttempted = false;
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
        // Soft/hard clock: SSE frames or successful /view-while-open (lastEventAt).
        // lastViewAt alone can clear LIVE across reopen races without delaying
        // hard kill when the open stream has gone fully quiet and /view fails.
        const silenceFrom =
          lastEventAt > 0 ? lastEventAt : streamOpenedAt > 0 ? streamOpenedAt : 0;
        if (silenceFrom <= 0) return;
        const age = now - silenceFrom;
        if (age < STALE_SOFT_MS) {
          publishConnected();
          return;
        }
        // Soft phase: one snapshot catch-up, leave EventSource open. Hard kill
        // only after STALE_HARD_MS (above server drain) — avoids reconnect thrash
        // when a large `state` briefly delays pings on the tunnel.
        if (age < STALE_HARD_MS) {
          publishConnected();
          if (!softCatchUpAttempted) {
            softCatchUpAttempted = true;
            void snapshotRefresh();
          }
          return;
        }
        forceStaleReconnect(fromGeneration);
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
      softCatchUpAttempted = false;
      // Keep lastViewAt — reconnect catch-up may finish before headers; LIVE
      // should clear as soon as streamOpen flips if /view just succeeded.
      setConnectedState(false);

      const catchUp = opts?.catchUp === true || lastVersionRef.current > 0;
      const knownVersion = lastVersionRef.current;

      try {
        // First paint: await snapshot so the station is not blank before SSE.
        // Reconnect / stale catch-up: refresh in parallel so we do not delay
        // opening the stream (and still recover if the tunnel SSE path is wedged).
        // Snapshot uses its own abort — not `signal` — so optics polls and this
        // catch-up are not cancelled by / do not cancel the EventSource lifecycle.
        // Intentionally no lastVersion hello / sendFull skip (server #251 stayed reverted).
        if (knownVersion === 0) {
          try {
            await snapshotRefresh();
          } catch {
            /* snapshotRefresh already notes errors */
          }
          if (signal.aborted || cancelled || myGeneration !== generation) return;
        } else if (catchUp) {
          void snapshotRefresh();
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
        // Headers alone are not enough; recent /view proof (catch-up) or the
        // first ping/state frame clears LIVE via publishConnected.
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
          void snapshotRefresh();
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
                if (payload.type === 'ping') {
                  // Small pings often still arrive through cloudflared when a
                  // multi-KB `state` frame was buffered/dropped. If the server
                  // is ahead, catch up with GET /view (same path as F5).
                  if (
                    typeof payload.stateVersion === 'number' &&
                    payload.stateVersion > lastVersionRef.current
                  ) {
                    void snapshotRefresh();
                  }
                  continue;
                }
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
      // Key off streamOpen — not the LIVE indicator. `connected` stays false
      // until the first ping/state (or snapshot-while-open); treating that as
      // "down" aborted healthy streams on visibility/online and left the
      // header stuck on RECONNECTING while catch-up `/view` kept the UI alive.
      if (!streamOpen) {
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
      snapshotAbort?.abort();
      streamOpen = false;
      setConnectedState(false);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kickIfNeeded);
    };
  }, [gameId, token, enabled]);

  const refresh = () => refreshRef.current();

  return { view, stateVersion, connected, error, setView, refresh };
}
