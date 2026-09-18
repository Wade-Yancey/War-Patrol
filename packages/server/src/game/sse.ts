import type { FastifyReply } from 'fastify';
import type { ClientView } from '@war-patrol/shared';

export interface SseClient {
  id: string;
  gameId: string;
  role: 'umpire' | 'vessel';
  unitId?: string;
  stationId?: string;
  reply: FastifyReply;
  lastSentVersion: number;
}

type ViewBuilder = (client: SseClient) => ClientView | null;

/**
 * SSE hub — one connection per open station/umpire tab.
 * Pushes stateVersion envelopes; clients reconnect and full-refresh on gaps.
 */
export class SseHub {
  private clients = new Map<string, SseClient>();
  private viewBuilder: ViewBuilder | null = null;
  /** Optional hook so runtime can rebroadcast connection counts (umpire live panel). */
  onConnectionsChanged: ((gameId: string) => void) | null = null;

  setViewBuilder(builder: ViewBuilder): void {
    this.viewBuilder = builder;
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
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    reply.raw.write(`: connected\n\n`);

    const onClose = () => {
      if (!this.clients.delete(client.id)) return;
      this.onConnectionsChanged?.(client.gameId);
    };
    reply.raw.on('close', onClose);
    reply.raw.on('error', onClose);
    this.onConnectionsChanged?.(client.gameId);
  }

  remove(id: string): void {
    const existing = this.clients.get(id);
    if (!this.clients.delete(id) || !existing) return;
    this.onConnectionsChanged?.(existing.gameId);
  }

  /** Connection counts for multi-connect indicator (ARCH-AC-09–12). */
  connectionSummary(gameId: string): Array<{
    unitId: string | null;
    stationId: string | null;
    role: 'umpire' | 'vessel';
    count: number;
  }> {
    const keyCount = new Map<string, { unitId: string | null; stationId: string | null; role: 'umpire' | 'vessel'; count: number }>();
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
    for (const client of this.clients.values()) {
      if (client.gameId !== gameId) continue;
      const view = this.viewBuilder(client);
      if (!view) continue;
      this.send(client, stateVersion, view);
    }
  }

  sendFull(client: SseClient, stateVersion: number, view: ClientView): void {
    this.send(client, stateVersion, view);
  }

  private send(client: SseClient, stateVersion: number, view: ClientView): void {
    const payload = JSON.stringify({ type: 'state', stateVersion, view });
    try {
      client.reply.raw.write(`event: state\ndata: ${payload}\n\n`);
      client.lastSentVersion = stateVersion;
    } catch {
      this.clients.delete(client.id);
    }
  }

  /** Heartbeat to keep proxies from closing idle streams. */
  startHeartbeat(intervalMs = 25000): NodeJS.Timeout {
    return setInterval(() => {
      for (const client of [...this.clients.values()]) {
        try {
          client.reply.raw.write(`: ping\n\n`);
        } catch {
          if (this.clients.delete(client.id)) {
            this.onConnectionsChanged?.(client.gameId);
          }
        }
      }
    }, intervalMs);
  }
}
