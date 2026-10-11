import type { FastifyReply } from 'fastify';
import type { ClientView, StationDef } from '@war-patrol/shared';

export interface SseClient {
  id: string;
  gameId: string;
  role: 'umpire' | 'vessel';
  unitId?: string;
  stationId?: string;
  reply: FastifyReply;
  lastSentVersion: number;
  /** True while Node reports write backpressure (`write` returned false). */
  waitingDrain?: boolean;
  /** Drop the client if drain never arrives (zombie high-RTT / tunnel stall). */
  drainTimer?: ReturnType<typeof setTimeout>;
}

type ViewBuilder = (client: SseClient) => ClientView | null;

/** Lower rank → earlier fan-out (lookout FoW before umpire bulk). */
function lookoutFanoutRank(client: SseClient): number {
  if (client.role !== 'vessel') return 2;
  // Sensors join URLs use stationId `sensors`; capability checked on the view.
  if (client.stationId === 'sensors') return 0;
  return 1;
}

function stationHasLookout(station: StationDef | undefined): boolean {
  return Boolean(station?.capabilities.includes('lookout'));
}

/**
 * Heartbeat interval — under common proxy/tablet idle cuts (~30–100s).
 * Slightly under 10s so high-RTT cloudflared clients still see pings before
 * edge/browser idle logic, and so the client stale watchdog (~25s) can miss
 * a couple without flapping LAN/STL paths.
 */
export const SSE_HEARTBEAT_MS = 8_000;

/** If `write()` backpressures longer than this, treat the socket as dead. */
const DRAIN_WATCHDOG_MS = 45_000;

/**
 * Comment padding so intermediaries that buffer small writes (cloudflared /
 * some CDN edges) still flush a ping frame to the browser. ~1KiB is enough
 * to punch through typical buffers without bloating quiet games.
 */
const PING_PAD = `: ${' '.repeat(1024)}\n`;

/**
 * SSE hub — one connection per open station/umpire tab.
 * Pushes stateVersion envelopes; clients reconnect and full-refresh on gaps.
 */
export class SseHub {
  private clients = new Map<string, SseClient>();
  private viewBuilder: ViewBuilder | null = null;
  /**
   * Latest broadcast stateVersion per game — echoed on heartbeat pings so
   * tunnel clients that still receive small pings (LIVE) but miss large
   * `state` frames can detect the gap and GET /view.
   */
  private latestVersionByGame = new Map<string, number>();
  /** Optional hook so runtime can rebroadcast connection counts (umpire live panel). */
  onConnectionsChanged: ((gameId: string) => void) | null = null;

  setViewBuilder(builder: ViewBuilder): void {
    this.viewBuilder = builder;
  }

  private noteVersion(gameId: string, stateVersion: number): void {
    const prev = this.latestVersionByGame.get(gameId) ?? 0;
    if (stateVersion >= prev) this.latestVersionByGame.set(gameId, stateVersion);
  }

  add(client: SseClient): void {
    this.clients.set(client.id, client);
    const reply = client.reply;
    // Hijack so Fastify does not finalize/buffer the long-lived stream.
    try {
      reply.hijack();
    } catch {
      /* already hijacked */
    }

    const socket = reply.raw.socket;
    if (socket) {
      // Quiet tablets / reverse proxies must not see an idle TCP timeout while
      // the game is between turns (no state events for minutes).
      socket.setTimeout(0);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
    }

    if (!reply.raw.headersSent) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx + Cloudflare respect this to disable response buffering on SSE.
        'X-Accel-Buffering': 'no',
      });
      const flushHeaders = (reply.raw as { flushHeaders?: () => void }).flushHeaders;
      try {
        flushHeaders?.call(reply.raw);
      } catch {
        /* ignore */
      }
    }
    this.writeRaw(client, `: connected\n\n`);

    const onClose = () => {
      this.clearDrainWatch(client);
      if (!this.clients.delete(client.id)) return;
      this.onConnectionsChanged?.(client.gameId);
    };
    reply.raw.on('close', onClose);
    reply.raw.on('error', onClose);
    this.onConnectionsChanged?.(client.gameId);
  }

  remove(id: string): void {
    const existing = this.clients.get(id);
    if (!existing) return;
    this.clearDrainWatch(existing);
    if (!this.clients.delete(id)) return;
    this.onConnectionsChanged?.(existing.gameId);
  }

  /** Drop all SSE clients for a game (e.g. save deleted / unloaded). */
  dropGame(gameId: string): void {
    for (const client of [...this.clients.values()]) {
      if (client.gameId !== gameId) continue;
      this.clearDrainWatch(client);
      this.clients.delete(client.id);
      try {
        client.reply.raw.end();
      } catch {
        /* ignore */
      }
    }
    this.latestVersionByGame.delete(gameId);
  }

  /** Connection counts for multi-connect indicator (ARCH-AC-09–12). */
  connectionSummary(gameId: string): Array<{
    unitId: string | null;
    stationId: string | null;
    role: 'umpire' | 'vessel';
    count: number;
  }> {
    const keyCount = new Map<
      string,
      { unitId: string | null; stationId: string | null; role: 'umpire' | 'vessel'; count: number }
    >();
    for (const c of this.clients.values()) {
      if (c.gameId !== gameId) continue;
      const key = `${c.role}|${c.unitId ?? ''}|${c.stationId ?? ''}`;
      const existing = keyCount.get(key);
      if (existing) existing.count += 1;
      else {
        keyCount.set(key, {
          unitId: c.unitId ?? null,
          stationId: c.stationId ?? null,
          role: c.role,
          count: 1,
        });
      }
    }
    return [...keyCount.values()];
  }

  stationConnectionCounts(
    gameId: string,
    unitId: string,
  ): Array<{ stationId: string; count: number }> {
    const counts = new Map<string, number>();
    for (const c of this.clients.values()) {
      if (c.gameId !== gameId || c.unitId !== unitId || !c.stationId) continue;
      counts.set(c.stationId, (counts.get(c.stationId) ?? 0) + 1);
    }
    return [...counts.entries()].map(([stationId, count]) => ({ stationId, count }));
  }

  broadcast(gameId: string, stateVersion: number): void {
    if (!this.viewBuilder) return;
    this.noteVersion(gameId, stateVersion);
    // Lookout / Sensors vessel tabs first so peri-feather FoW is serialized and
    // written before the umpire's multi-100KB history view on the same tick —
    // cloudflared remotes otherwise wait behind host-local umpire fan-out.
    const clients = [...this.clients.values()]
      .filter((c) => c.gameId === gameId)
      .sort((a, b) => lookoutFanoutRank(a) - lookoutFanoutRank(b));
    for (const client of clients) {
      // One client's view build failing (e.g. transient bad state) must not
      // abort the loop for every other connected station/umpire tab, and
      // must not throw synchronously out of a `close`/`error` socket event
      // listener (onConnectionsChanged is invoked from there) — an
      // uncaught throw in that context is an uncaught exception, not a
      // rejected promise a route handler can catch.
      try {
        const view = this.viewBuilder(client);
        if (!view) continue;
        // Slim lookout FoW before the multi-KB `state` frame so tunnel edges
        // that flush small SSE events can paint DD peri feathers without
        // waiting on the full vessel/umpire payload (not ping-before-state).
        if (view.role === 'vessel' && stationHasLookout(view.station)) {
          this.sendOptics(client, stateVersion, view);
        }
        this.send(client, stateVersion, view);
      } catch {
        /* skip this client this broadcast; next state push will retry */
      }
    }
  }

  /**
   * Lean join/leave fan-out — connection counts only, not a full vessel/umpire
   * view. Keeps cloudflared / tablet tabs from serializing multi-KB state on
   * every StrictMode remount or second station opening.
   */
  broadcastConnections(gameId: string, stateVersion: number): void {
    const umpireConnections = this.connectionSummary(gameId);
    for (const client of [...this.clients.values()]) {
      if (client.gameId !== gameId) continue;
      if (client.waitingDrain) continue;
      try {
        if (client.role === 'umpire') {
          const payload = JSON.stringify({
            type: 'connections',
            stateVersion,
            connections: umpireConnections,
          });
          this.writeRaw(client, `event: connections\ndata: ${payload}\n\n`);
          continue;
        }
        if (client.role === 'vessel' && client.unitId) {
          const payload = JSON.stringify({
            type: 'connections',
            stateVersion,
            stationConnections: this.stationConnectionCounts(gameId, client.unitId),
          });
          this.writeRaw(client, `event: connections\ndata: ${payload}\n\n`);
        }
      } catch {
        /* skip */
      }
    }
  }

  sendFull(client: SseClient, stateVersion: number, view: ClientView): void {
    this.send(client, stateVersion, view);
  }

  /**
   * Lightweight hello / liveness frame (padded ping with stateVersion).
   * Used when a reconnecting client already has the current snapshot so we do
   * not pile another multi-KB `state` onto a cloudflared pipe mid-thrash.
   */
  sendPing(client: SseClient, stateVersion: number): void {
    this.noteVersion(client.gameId, stateVersion);
    const payload = JSON.stringify({ type: 'ping', stateVersion });
    this.writeRaw(client, `${PING_PAD}event: ping\ndata: ${payload}\n\n`);
  }

  /**
   * Feather-relevant lookout FoW only — typically a few hundred bytes vs a
   * multi-KB full `state` view. Written (and uncorked) before `state` so
   * cloudflared can deliver peri feathers while the large frame is still in
   * flight. Does not advance `lastSentVersion` (full state / GET /view still
   * reconcile the rest of the vessel picture).
   */
  private sendOptics(
    client: SseClient,
    stateVersion: number,
    view: Extract<ClientView, { role: 'vessel' }>,
  ): void {
    if (client.waitingDrain) return;
    this.noteVersion(client.gameId, stateVersion);
    const payload = JSON.stringify({
      type: 'optics',
      stateVersion,
      // Always include arrays so raise/lower clears feathers & sightings on the
      // client even when the trailing full `state` is still buffered.
      periscopeContacts: view.periscopeContacts ?? [],
      opticsSightings: view.opticsSightings ?? [],
      ...(typeof view.periscopeMaxRangeNm === 'number'
        ? { periscopeMaxRangeNm: view.periscopeMaxRangeNm }
        : {}),
      ...(typeof view.periscopeOperational === 'boolean'
        ? { periscopeOperational: view.periscopeOperational }
        : {}),
      ...(view.periscopeUnavailableReason
        ? { periscopeUnavailableReason: view.periscopeUnavailableReason }
        : {}),
      periscopeRaised: Boolean(view.unit.periscopeRaised),
      periscopeExposure: Number(view.unit.periscopeExposure) || 0,
    });
    const raw = client.reply.raw;
    const socket = raw.socket as { cork?: () => void; uncork?: () => void } | null;
    try {
      socket?.cork?.();
    } catch {
      /* ignore */
    }
    try {
      this.writeRaw(client, `event: optics\ndata: ${payload}\n\n${PING_PAD}\n`);
    } finally {
      try {
        socket?.uncork?.();
      } catch {
        /* ignore */
      }
    }
  }

  private send(client: SseClient, stateVersion: number, view: ClientView): void {
    // Backpressured tunnel sockets cannot accept another multi-KB frame —
    // piling on delays drain and starves heartbeats (client reconnect thrash).
    // Client catches up via GET /view / next push after drain.
    if (client.waitingDrain) return;
    this.noteVersion(client.gameId, stateVersion);
    const payload = JSON.stringify({ type: 'state', stateVersion, view });
    // Trailing pad comment punches the large state frame through the same
    // cloudflared / edge buffers that otherwise flush only small pings —
    // mid-turn FoW (e.g. DD lookout feather on peri raise) was landing on
    // loopback but stalling for tunnel remotes until a full page refresh.
    if (this.writeRaw(client, `event: state\ndata: ${payload}\n\n${PING_PAD}\n`)) {
      client.lastSentVersion = stateVersion;
    }
  }

  /**
   * Heartbeat to keep proxies / tablet browsers from closing quiet streams.
   * Padded comment wakes buffered intermediaries; named `ping` event resets
   * client stale watchdogs that only count parsed SSE frames (not raw bytes).
   * Includes `stateVersion` so clients can catch up via GET /view when a
   * full `state` frame was dropped/buffered by the tunnel.
   */
  startHeartbeat(intervalMs = SSE_HEARTBEAT_MS): NodeJS.Timeout {
    return setInterval(() => {
      for (const client of [...this.clients.values()]) {
        // Do not enqueue more bytes on a backpressured socket — wait for drain.
        if (client.waitingDrain) continue;
        const stateVersion = this.latestVersionByGame.get(client.gameId) ?? 0;
        this.sendPing(client, stateVersion);
      }
    }, intervalMs);
  }

  private clearDrainWatch(client: SseClient): void {
    if (client.drainTimer !== undefined) {
      clearTimeout(client.drainTimer);
      client.drainTimer = undefined;
    }
    client.waitingDrain = false;
  }

  private dropClient(id: string): void {
    const existing = this.clients.get(id);
    if (!existing) return;
    this.clearDrainWatch(existing);
    if (!this.clients.delete(id)) return;
    this.onConnectionsChanged?.(existing.gameId);
  }

  private writeRaw(client: SseClient, chunk: string): boolean {
    try {
      const raw = client.reply.raw;
      if (raw.writableEnded || raw.destroyed) {
        this.dropClient(client.id);
        return false;
      }
      const ok = raw.write(chunk);
      // Compression / transform streams (if any proxy layer adds them) need an
      // explicit flush; plain sockets no-op.
      const flushable = raw as { flush?: () => void };
      try {
        flushable.flush?.();
      } catch {
        /* ignore */
      }

      if (!ok && !client.waitingDrain) {
        // High-RTT tunnel clients can backpressure for a while; if drain never
        // fires the fan-out would keep a silent dead connection forever.
        client.waitingDrain = true;
        const onDrain = () => {
          this.clearDrainWatch(client);
          // Immediate small ping after drain so the client stale watchdog sees
          // a parsed frame without waiting for the next ~8s heartbeat — and
          // without another multi-KB state while the pipe is still tender.
          const stateVersion = this.latestVersionByGame.get(client.gameId) ?? 0;
          this.sendPing(client, stateVersion);
        };
        raw.once('drain', onDrain);
        client.drainTimer = setTimeout(() => {
          if (!client.waitingDrain) return;
          try {
            raw.end();
          } catch {
            /* ignore */
          }
          this.dropClient(client.id);
        }, DRAIN_WATCHDOG_MS);
      }
      return true;
    } catch {
      this.dropClient(client.id);
      return false;
    }
  }
}
