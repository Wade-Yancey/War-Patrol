import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AuthSession,
  EotSetting,
  Faction,
  FlightLevel,
  HullClass,
  SubsystemState,
  UnitCondition,
  VesselType,
} from '@war-patrol/shared';
import { nanoid } from 'nanoid';
import * as store from '../store/fileStore.js';
import { parseBearer, parseSseToken } from '../game/sessions.js';
import { runtime } from '../game/runtime.js';
import { buildViewForSession } from '../game/views.js';
import type { SseClient } from '../game/sse.js';

function httpError(err: unknown): { statusCode: number; message: string } {
  if (err && typeof err === 'object' && 'statusCode' in err && 'message' in err) {
    return {
      statusCode: Number((err as { statusCode: number }).statusCode) || 500,
      message: String((err as { message: string }).message),
    };
  }
  return { statusCode: 500, message: err instanceof Error ? err.message : 'Internal error' };
}

function sessionFromToken(token: string | undefined, gameId?: string): AuthSession {
  const session = runtime.sessions.get(token);
  if (!session) {
    throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
  }
  if (gameId && session.gameId !== gameId) {
    throw Object.assign(new Error('Wrong game'), { statusCode: 403 });
  }
  return session;
}

function requireSession(request: FastifyRequest, gameId?: string): AuthSession {
  return sessionFromToken(parseBearer(request.headers.authorization), gameId);
}

/** SSE-only: Bearer or `?token=` (browser EventSource cannot set Authorization). */
function requireSseSession(
  request: FastifyRequest<{ Querystring: { token?: string } }>,
  gameId?: string,
): AuthSession {
  return sessionFromToken(
    parseSseToken(request.headers.authorization, request.query?.token),
    gameId,
  );
}

function requireUmpire(request: FastifyRequest, gameId?: string): AuthSession {
  const session = requireSession(request, gameId);
  if (session.role !== 'umpire') {
    throw Object.assign(new Error('Umpire access required'), { statusCode: 403 });
  }
  return session;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/scenarios', async () => {
    const scenarios = await store.listScenarios();
    return scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      mode: s.mode,
      unitCount: s.units.length,
    }));
  });

  app.get('/api/library', async () => store.listVesselClasses());

  app.get('/api/saves', async () => store.listSaves());

  app.delete<{ Params: { saveId: string } }>('/api/saves/:saveId', async (request, reply) => {
    try {
      const result = await runtime.deleteSave(request.params.saveId);
      return { ok: true, ...result };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.delete<{ Params: { scenarioId: string } }>(
    '/api/scenarios/:scenarioId',
    async (request, reply) => {
      try {
        await runtime.deleteScenario(request.params.scenarioId);
        return { ok: true };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  app.get('/api/games', async () => runtime.listActiveGames());

  app.post<{ Body: { scenarioId: string; name?: string } }>('/api/games', async (request, reply) => {
    try {
      const { scenarioId, name } = request.body ?? {};
      if (!scenarioId) {
        return reply.code(400).send({ error: 'scenarioId required' });
      }
      const save = await runtime.createFromScenario(scenarioId, name);
      return {
        gameId: save.id,
        name: save.name,
        stateVersion: save.stateVersion,
        vesselLinks: save.units.map((u) => ({
          unitId: u.id,
          name: u.name,
          accessToken: u.accessToken,
          passwordProtected: Boolean(u.password),
          stations: u.stations.map((s) => ({
            stationId: s.id,
            name: s.name,
            path: `/g/${save.id}/v/${u.accessToken}/s/${s.id}`,
          })),
        })),
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { saveId: string } }>('/api/saves/:saveId/load', async (request, reply) => {
    try {
      const save = await runtime.loadSaveIntoMemory(request.params.saveId);
      return { gameId: save.id, name: save.name, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode === 500 ? 404 : e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/save', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = await runtime.persist(request.params.gameId);
      return { ok: true, id: save.id, updatedAt: save.updatedAt };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/export', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.requireGame(request.params.gameId);
      return save;
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { password?: string };
  }>('/api/games/:gameId/auth/umpire', async (request, reply) => {
    try {
      const session = runtime.authUmpire(request.params.gameId, request.body?.password ?? '');
      return { token: session.token, role: session.role };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { accessToken: string; password?: string; stationId: string };
  }>('/api/games/:gameId/auth/vessel', async (request, reply) => {
    try {
      const { accessToken, password, stationId } = request.body ?? {};
      if (!accessToken || !stationId) {
        return reply.code(400).send({ error: 'accessToken and stationId required' });
      }
      const session = runtime.authVessel(
        request.params.gameId,
        accessToken,
        password,
        stationId,
      );
      return {
        token: session.token,
        role: session.role,
        unitId: session.unitId,
        stationId: session.stationId,
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/view', async (request, reply) => {
    try {
      const session = requireSession(request, request.params.gameId);
      const save = runtime.requireGame(session.gameId);
      const view = buildViewForSession(
        save,
        runtime.sse,
        session.role,
        session.unitId,
        session.stationId,
      );
      if (!view) return reply.code(404).send({ error: 'View unavailable' });
      return { stateVersion: save.stateVersion, view };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.get<{
    Params: { gameId: string };
    Querystring: { lastVersion?: string; token?: string };
  }>('/api/games/:gameId/events', async (request, reply) => {
    try {
      const session = requireSseSession(request, request.params.gameId);
      const save = runtime.requireGame(session.gameId);
      const client: SseClient = {
        id: nanoid(16),
        gameId: session.gameId,
        role: session.role,
        unitId: session.unitId,
        stationId: session.stationId,
        reply,
        lastSentVersion: 0,
      };
      runtime.sse.add(client);

      const view = buildViewForSession(
        save,
        runtime.sse,
        session.role,
        session.unitId,
        session.stationId,
      );
      if (view) {
        runtime.sse.sendFull(client, save.stateVersion, view);
      }

      // Keep the request open after hijack; resolve when the client disconnects.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          runtime.sse.remove(client.id);
          resolve();
        };
        request.raw.on('close', done);
        reply.raw.on('close', done);
      });
    } catch (err) {
      const e = httpError(err);
      if (!reply.raw.headersSent) {
        return reply.code(e.statusCode).send({ error: e.message });
      }
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { course?: number; eot?: EotSetting };
  }>('/api/games/:gameId/orders', async (request, reply) => {
    try {
      const session = requireSession(request, request.params.gameId);
      if (session.role !== 'vessel' || !session.unitId || !session.stationId) {
        return reply.code(403).send({ error: 'Vessel station session required' });
      }
      const save = runtime.submitOrders(
        session.gameId,
        session.unitId,
        session.stationId,
        request.body ?? {},
      );
      return { ok: true, stateVersion: save.stateVersion, orders: save.units.find((u) => u.id === session.unitId)?.orders };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  // --- Umpire turn controls ---
  app.post<{ Params: { gameId: string }; Body: { seconds: number } }>(
    '/api/games/:gameId/turn/timer',
    async (request, reply) => {
      try {
        requireUmpire(request, request.params.gameId);
        const seconds = Number(request.body?.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return reply.code(400).send({ error: 'seconds required' });
        }
        const save = runtime.setTimer(request.params.gameId, seconds);
        return { turn: save.turn, stateVersion: save.stateVersion };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  app.post<{ Params: { gameId: string }; Body: { seconds: number } }>(
    '/api/games/:gameId/turn/extend',
    async (request, reply) => {
      try {
        requireUmpire(request, request.params.gameId);
        const seconds = Number(request.body?.seconds ?? 60);
        const save = runtime.extendTimer(request.params.gameId, seconds);
        return { turn: save.turn, stateVersion: save.stateVersion };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/turn/reset-timer', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.resetTimer(request.params.gameId);
      return { turn: save.turn, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/turn/lock', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.lockTurn(request.params.gameId);
      return { turn: save.turn, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/turn/reopen', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.reopenTurn(request.params.gameId);
      return { turn: save.turn, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/turn/resolve', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = await runtime.resolve(request.params.gameId);
      return { turn: save.turn, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/history', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.requireGame(request.params.gameId);
      return {
        turns: save.history.map((h) => ({
          turnNumber: h.turnNumber,
          resolvedAt: h.resolvedAt,
          stateVersion: h.stateVersion,
          gameTimeSeconds: h.gameTimeSeconds ?? h.turn.gameTimeSeconds,
        })),
        turnLengthSeconds: save.turnLengthSeconds,
        gameTimeSeconds: save.turn.gameTimeSeconds,
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { turnNumber: number; confirm?: string };
  }>('/api/games/:gameId/rollback', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const turnNumber = Number(request.body?.turnNumber);
      if (!Number.isFinite(turnNumber)) {
        return reply.code(400).send({ error: 'turnNumber required' });
      }
      const confirm = request.body?.confirm;
      if (typeof confirm !== 'string' || !confirm.trim()) {
        return reply.code(400).send({
          error: 'confirm required — type ROLLBACK or the target turn number (ARCH-SM-13)',
        });
      }
      const save = await runtime.rollback(request.params.gameId, turnNumber, confirm);
      return { turn: save.turn, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.patch<{
    Params: { gameId: string; unitId: string };
    Body: {
      health?: number;
      heading?: number;
      speed?: number;
      name?: string;
      password?: string;
      type?: string;
      class?: string;
      faction?: string;
      flightLevel?: string;
      condition?: string;
      subsystems?: { propulsion?: string; sensors?: string };
      position?: { lat?: number; lon?: number; depth?: number };
    };
  }>('/api/games/:gameId/units/:unitId', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const body = request.body ?? {};
      const save = runtime.updateUnit(request.params.gameId, request.params.unitId, {
        health: body.health,
        heading: body.heading,
        speed: body.speed,
        name: body.name,
        password: body.password,
        type: body.type as VesselType | undefined,
        class: body.class as HullClass | undefined,
        faction: body.faction as Faction | undefined,
        flightLevel: body.flightLevel as FlightLevel | undefined,
        condition: body.condition as UnitCondition | undefined,
        subsystems: body.subsystems
          ? {
              propulsion: body.subsystems.propulsion as SubsystemState | undefined,
              sensors: body.subsystems.sensors as SubsystemState | undefined,
            }
          : undefined,
        position: body.position,
      });
      return { ok: true, stateVersion: save.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string }; Body: { password?: string } }>(
    '/api/games/:gameId/umpire-password',
    async (request, reply) => {
      try {
        requireUmpire(request, request.params.gameId);
        const save = runtime.setUmpirePassword(
          request.params.gameId,
          request.body?.password ?? '',
        );
        return { ok: true, stateVersion: save.stateVersion };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  app.post<{ Params: { gameId: string; unitId: string } }>(
    '/api/games/:gameId/units/:unitId/rotate-token',
    async (request, reply) => {
      try {
        requireUmpire(request, request.params.gameId);
        const save = runtime.rotateAccessToken(request.params.gameId, request.params.unitId);
        const unit = save.units.find((u) => u.id === request.params.unitId);
        return { accessToken: unit?.accessToken, stateVersion: save.stateVersion };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );
}
