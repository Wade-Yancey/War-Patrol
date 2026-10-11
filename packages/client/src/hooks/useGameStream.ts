import { useEffect, useRef, useState } from 'react';
import type { ClientView, UmpireView, VesselView } from '@war-patrol/shared';
import { api } from '../api/client';
import { isWpDebugEnabled, wpDebug } from '../debug/wpDebug';

interface Options {
  gameId: string;
  token: string | null;
  enabled?: boolean;
  /** Stale session (server restart / revoked) — clear storage and return to login. */
  onAuthInvalid?: () => void;
}

export type ViewRefreshReason =
  | 'initial'
  | 'catchUp'
  | 'firstStateFallback'
  | 'pingGap'
  | 'kickRefresh'
  | 'softView'
  | 'manual'
  | 'unknown';

const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 12_000;
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
    msg === 'SSE stale timeout' ||
    msg === 'SSE disconnected' ||
    msg === 'SSE error' ||
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
    msg === 'sse failed (403)' ||
    msg.includes('401') ||
    msg.includes('403')
  );
}

/**
 * Parse one SSE block (`\n\n`-delimited). Named events carry JSON in `data:`.
 * Comment-only blocks (padding / `: connected`) are ignored.
 */
function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * SSE subscription with auto-reconnect and full refresh on version gaps (ARCH-SA-05–08).
 *
 * Uses `fetch` **POST** `/events` + `Authorization: Bearer` (not native EventSource).
 * Cloudflare quick tunnels (`*.trycloudflare.com`) buffer GET streaming until the
 * origin closes — EventSource can only GET, so it stayed CONNECTING forever while
 * finite GET `/view` still worked (cloudflared#1449; Wade after #259–#261). POST
 * streams live on the same path. Snapshot `GET /view` uses a separate AbortController
 * so soft/catch-up polls cannot abort the live stream. Visibility/`online` must not
 * reopen while a stream attempt is pending or open. Aborted/superseded attempts must
 * not schedule a second reconnect.
 */
export function useGameStream({ gameId, token, enabled = true, onAuthInvalid }: Options) {
  const [view, setView] = useState<ClientView | null>(null);
  const [stateVersion, setStateVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastVersionRef = useRef(0);
  const refreshRef = useRef<(reason?: ViewRefreshReason) => Promise<void>>(
    async () => undefined,
  );
  const connectedRef = useRef(false);
  const onAuthInvalidRef = useRef(onAuthInvalid);
  onAuthInvalidRef.current = onAuthInvalid;

  useEffect(() => {
    if (!enabled || !token || !gameId) return;

    let cancelled = false;
    let reconnectTimer: number | undefined;
    let staleTimer: number | undefined;
    let firstStateTimer: number | undefined;
    /** Snapshot `/view` only — must not share a signal with the live stream. */
    let viewAbort: AbortController | undefined;
    /** Live POST `/events` body only. */
    let streamAbort: AbortController | undefined;
    /** True from POST start until headers OK, error, or abort — kick must not tear this down. */
    let streamPending = false;
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
    /** Diagnostics-only clocks — do not affect LIVE / reconnect policy. */
    let lastPingAt = 0;
    let lastStateAt = 0;
    let lastViewAt = 0;
    let lastConnectionsAt = 0;
    let staleForceCount = 0;
    const debug = isWpDebugEnabled();

    const debugSnap = (extra?: Record<string, unknown>) => {
      const now = Date.now();
      return {
        gen: generation,
        streamOpen,
        streamPending,
        connected: connectedRef.current,
        lastVersion: lastVersionRef.current,
        ageEventMs: lastEventAt ? now - lastEventAt : null,
        agePingMs: lastPingAt ? now - lastPingAt : null,
        ageStateMs: lastStateAt ? now - lastStateAt : null,
        ageViewMs: lastViewAt ? now - lastViewAt : null,
        ageConnMs: lastConnectionsAt ? now - lastConnectionsAt : null,
        staleForceCount,
        attempt,
        ...extra,
      };
    };

    const setConnectedState = (value: boolean) => {
      if (debug && connectedRef.current !== value) {
        wpDebug('connected', debugSnap({ next: value }));
      }
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

    const clearFirstState = () => {
      if (firstStateTimer !== undefined) {
        window.clearTimeout(firstStateTimer);
        firstStateTimer = undefined;
      }
    };

    const abortStream = () => {
      clearFirstState();
      streamPending = false;
      try {
        streamAbort?.abort();
      } catch {
        /* ignore */
      }
      streamAbort = undefined;
    };

    const scheduleReconnect = (fromGeneration: number) => {
      if (cancelled || authInvalid || fromGeneration !== generation) return;
      clearReconnect();
      const exp = Math.min(attempt, 5);
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exp);
      const jitter = Math.floor(Math.random() * 300);
      if (debug) {
        wpDebug('scheduleReconnect', debugSnap({ delayMs: delay + jitter, fromGeneration }));
      }
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
      abortStream();
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
      if (err instanceof Error && err.message === 'SSE stale timeout') {
        setError('Connection interrupted — retrying…');
        return;
      }
      setError(err instanceof Error ? err.message : 'SSE disconnected');
    };

    const fullRefresh = async (signal?: AbortSignal, reason: ViewRefreshReason = 'unknown') => {
      const started = Date.now();
      if (debug) {
        wpDebug('viewStart', debugSnap({ reason, aborted: Boolean(signal?.aborted) }));
      }
      try {
        const data = await api.view(gameId, token, { signal });
        if (cancelled || signal?.aborted) {
          if (debug) {
            wpDebug('viewAbort', debugSnap({ reason, ms: Date.now() - started, phase: 'afterFetch' }));
          }
          return;
        }
        lastVersionRef.current = data.stateVersion;
        lastViewAt = Date.now();
        // Snapshot catch-up is urgent — do not defer behind optics transitions.
        setStateVersion(data.stateVersion);
        setView(data.view);
        setError(null);
        if (debug) {
          const vessel = data.view.role === 'vessel' ? data.view : null;
          wpDebug(
            'viewOk',
            debugSnap({
              reason,
              ms: Date.now() - started,
              stateVersion: data.stateVersion,
              periRaised: vessel?.unit.periscopeRaised ?? null,
              contactCount: vessel?.periscopeContacts?.length ?? null,
              sightingCount: vessel?.opticsSightings?.length ?? null,
            }),
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (debug) {
            wpDebug('viewAbort', debugSnap({ reason, ms: Date.now() - started, phase: 'fetch' }));
          }
          throw err;
        }
        if (debug) {
          wpDebug(
            'viewFail',
            debugSnap({
              reason,
              ms: Date.now() - started,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        throw err;
      }
    };
    refreshRef.current = async (reason: ViewRefreshReason = 'manual') => {
      try {
        await fullRefresh(viewAbort?.signal, reason);
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
      lastStateAt = Date.now();
      // Apply urgently — mid-turn FoW (DD lookout feather on peri raise/lower)
      // must land without waiting on a transition. Optics chrome stays snappy via
      // StationPage `useDeferredValue` + local-first mast overlay (#235), not by
      // deferring the whole vessel view (that left tunnel remotes stale until F5).
      setStateVersion(stateVersionNext);
      setView(nextView);
      if (debug) {
        const vessel = nextView.role === 'vessel' ? nextView : null;
        wpDebug(
          'stateFrame',
          debugSnap({
            stateVersion: stateVersionNext,
            periRaised: vessel?.unit.periscopeRaised ?? null,
            contactCount: vessel?.periscopeContacts?.length ?? null,
            sightingCount: vessel?.opticsSightings?.length ?? null,
          }),
        );
      }
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

    const handlePayload = (
      raw: string,
      myGeneration: number,
      viewSignal: AbortSignal,
      markState: () => void,
    ) => {
      if (cancelled || myGeneration !== generation || authInvalid) return;
      try {
        const payload = JSON.parse(raw) as {
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
          lastPingAt = Date.now();
          // Small pings often still arrive through cloudflared when a
          // multi-KB `state` frame was buffered/dropped. If the server
          // is ahead, catch up with GET /view (same path as F5).
          if (
            typeof payload.stateVersion === 'number' &&
            payload.stateVersion > lastVersionRef.current
          ) {
            if (debug) {
              wpDebug(
                'pingGap',
                debugSnap({
                  pingVersion: payload.stateVersion,
                  localVersion: lastVersionRef.current,
                }),
              );
            }
            void fullRefresh(viewSignal, 'pingGap').catch((err) => {
              if (viewSignal.aborted || cancelled || myGeneration !== generation) {
                return;
              }
              if (isAuthFailure(err)) handleAuthInvalid();
            });
          }
          return;
        }
        if (payload.type === 'connections') {
          lastConnectionsAt = Date.now();
          applyConnections(payload);
          return;
        }
        if (payload.type !== 'state' || payload.view == null || payload.stateVersion == null) {
          return;
        }
        markState();
        // SSE state frames are full views — apply directly (including gaps /
        // rollbacks). Avoid a second GET /view that stalls remote Controls.
        applyState(payload.stateVersion, payload.view);
      } catch {
        /* ignore parse errors */
      }
    };

    const forceStaleReconnect = (fromGeneration: number) => {
      if (cancelled || authInvalid || fromGeneration !== generation) return;
      staleForceCount += 1;
      if (debug) {
        wpDebug('staleForce', debugSnap({ fromGeneration }));
      }
      streamOpen = false;
      publishConnected();
      attempt += 1;
      noteStreamFailure(new Error('SSE stale timeout'));
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

    const openSse = async (opts?: { catchUp?: boolean }) => {
      if (cancelled || authInvalid) return;

      clearReconnect();
      clearStaleWatch();
      abortStream();
      try {
        viewAbort?.abort();
      } catch {
        /* ignore */
      }
      const myGeneration = ++generation;
      viewAbort = new AbortController();
      streamAbort = new AbortController();
      const viewSignal = viewAbort.signal;
      const streamSignal = streamAbort.signal;

      streamOpen = false;
      streamPending = false;
      streamOpenedAt = 0;
      lastEventAt = 0;
      lastPingAt = 0;
      lastStateAt = 0;
      lastConnectionsAt = 0;
      setConnectedState(false);

      const catchUp = opts?.catchUp === true || lastVersionRef.current > 0;
      if (debug) {
        wpDebug('sseOpen', debugSnap({ catchUp, myGeneration, method: 'POST' }));
      }

      // First paint: await snapshot so the station is not blank before SSE.
      // Reconnect / stale catch-up: refresh in parallel so we do not delay
      // opening the stream (and still recover if the tunnel SSE path is wedged).
      if (lastVersionRef.current === 0) {
        try {
          await fullRefresh(viewSignal, 'initial');
        } catch (err) {
          if (viewSignal.aborted || cancelled) return;
          if (isAuthFailure(err)) {
            handleAuthInvalid();
            return;
          }
          setError(err instanceof Error ? err.message : 'Refresh failed');
        }
        if (viewSignal.aborted || cancelled || myGeneration !== generation) return;
      } else if (catchUp) {
        void fullRefresh(viewSignal, 'catchUp').catch((err) => {
          if (viewSignal.aborted || cancelled || myGeneration !== generation) return;
          if (isAuthFailure(err)) handleAuthInvalid();
        });
      }

      if (cancelled || authInvalid || myGeneration !== generation) return;

      // POST + Bearer: quick-tunnel GET buffering cannot apply; fetch can set
      // Authorization (EventSource cannot). Relative same-origin URL.
      const eventsUrl = `/api/games/${gameId}/events`;
      streamPending = true;
      if (debug) {
        wpDebug('esCreate', debugSnap({ myGeneration, method: 'POST', url: eventsUrl }));
      }

      try {
        const res = await fetch(eventsUrl, {
          method: 'POST',
          signal: streamSignal,
          cache: 'no-store',
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
        });
        if (cancelled || authInvalid || myGeneration !== generation) return;

        if (!res.ok || !res.body) {
          streamPending = false;
          if (res.status === 401 || res.status === 403) {
            if (debug) {
              wpDebug(
                'sseAuthFail',
                debugSnap({ myGeneration, status: res.status, method: 'POST' }),
              );
            }
            handleAuthInvalid();
            return;
          }
          throw new Error(`SSE failed (${res.status})`);
        }

        streamPending = false;
        streamOpen = true;
        streamOpenedAt = Date.now();
        if (debug) {
          wpDebug(
            'streamOpen',
            debugSnap({
              myGeneration,
              method: 'POST',
              contentType: res.headers.get('content-type'),
            }),
          );
        }
        // Headers alone are not "connected" for LIVE — wait for a ping/state frame.
        publishConnected();
        setError(null);
        attempt = 0;
        armStaleWatch(myGeneration);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawState = false;

        clearFirstState();
        firstStateTimer = window.setTimeout(() => {
          firstStateTimer = undefined;
          if (cancelled || streamSignal.aborted || myGeneration !== generation || sawState) {
            return;
          }
          if (debug) {
            wpDebug('firstStateFallback', debugSnap({ myGeneration }));
          }
          void fullRefresh(viewSignal, 'firstStateFallback').catch((err) => {
            if (isAuthFailure(err)) handleAuthInvalid();
          });
        }, FIRST_STATE_FALLBACK_MS);

        try {
          while (!cancelled && !streamSignal.aborted && myGeneration === generation) {
            const { done, value } = await reader.read();
            if (done) {
              if (debug) {
                wpDebug('sseDone', debugSnap({ myGeneration }));
              }
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop() ?? '';
            for (const chunk of chunks) {
              const parsed = parseSseBlock(chunk);
              if (!parsed) continue;
              handlePayload(parsed.data, myGeneration, viewSignal, () => {
                sawState = true;
              });
            }
          }
        } finally {
          clearFirstState();
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }

        if (cancelled || streamSignal.aborted || myGeneration !== generation || authInvalid) {
          if (debug && (cancelled || streamSignal.aborted)) {
            wpDebug(
              'sseClose',
              debugSnap({
                myGeneration,
                cancelled,
                aborted: streamSignal.aborted,
              }),
            );
          }
          return;
        }

        streamOpen = false;
        streamPending = false;
        clearStaleWatch();
        setConnectedState(false);
        attempt += 1;
        if (debug) {
          wpDebug('sseDisconnected', debugSnap({ myGeneration }));
        }
        noteStreamFailure(new Error('SSE disconnected'));
        scheduleReconnect(myGeneration);
      } catch (err) {
        streamPending = false;
        if (cancelled || streamSignal.aborted || myGeneration !== generation || authInvalid) {
          if (debug && streamSignal.aborted) {
            wpDebug('sseAbort', debugSnap({ myGeneration }));
          }
          return;
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (debug) {
            wpDebug('sseAbort', debugSnap({ myGeneration }));
          }
          return;
        }

        streamOpen = false;
        clearStaleWatch();
        setConnectedState(false);
        attempt += 1;
        if (debug) {
          wpDebug(
            'sseError',
            debugSnap({
              myGeneration,
              method: 'POST',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        noteStreamFailure(err);
        scheduleReconnect(myGeneration);
      }
    };

    const kickIfNeeded = () => {
      if (cancelled || authInvalid) return;
      if (document.visibilityState === 'hidden') return;
      // Key off stream lifecycle — not the LIVE indicator. `connected` stays
      // false until the first ping/state after open; treating that (or a pending
      // POST) as "down" called openSse → abortStream and aborted nascent streams.
      const streamPendingOrOpen = streamPending || streamOpen;
      if (!streamPendingOrOpen) {
        if (debug) {
          wpDebug('kickReconnect', debugSnap({ why: 'noStream' }));
        }
        attempt = 0;
        clearReconnect();
        void openSse({ catchUp: true });
      } else {
        // Stream opening or open — snapshot catch-up only; do not tear down POST.
        if (debug) {
          wpDebug(
            'kickRefresh',
            debugSnap({
              why: connectedRef.current ? 'connected' : 'streamPendingOrOpen',
            }),
          );
        }
        void refreshRef.current('kickRefresh');
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
      abortStream();
      try {
        viewAbort?.abort();
      } catch {
        /* ignore */
      }
      streamOpen = false;
      streamPending = false;
      setConnectedState(false);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kickIfNeeded);
    };
  }, [gameId, token, enabled]);

  const refresh = (reason: ViewRefreshReason = 'manual') => refreshRef.current(reason);

  return { view, stateVersion, connected, error, setView, refresh };
}
