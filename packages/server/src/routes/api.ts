import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AuthSession,
  DivePlanesState,
  EotSetting,
  Faction,
  FlightLevel,
  HullClass,
  PropulsionState,
  SteeringState,
  SubsystemState,
  UnitCondition,
  VesselType,
} from '@war-patrol/shared';
import { isV1PlayerUnit } from '@war-patrol/shared';
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

/**
 * Gate host/disk admin surface (create game, load/delete saves, delete scenarios,
 * list saves/scenarios/games) behind `WAR_PATROL_ADMIN_TOKEN` when set.
 *
 * Unset (default): no-op, matching the existing LAN-party trust model exactly —
 * this is the "clear config switch" that avoids weakening local play. Set it when
 * exposing the server beyond a trusted LAN (see docs/internet-hosting.md upstream).
 */
function requireAdmin(request: FastifyRequest): void {
  const adminToken = process.env.WAR_PATROL_ADMIN_TOKEN;
  if (!adminToken) return;
  const headerToken =
    parseBearer(request.headers.authorization) ??
    (typeof request.headers['x-admin-token'] === 'string'
      ? (request.headers['x-admin-token'] as string)
      : undefined);
  if (headerToken !== adminToken) {
    throw Object.assign(new Error('Admin token required'), { statusCode: 401 });
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/scenarios', async (request, reply) => {
    try {
      requireAdmin(request);
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
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

  app.get('/api/saves', async (request, reply) => {
    try {
      requireAdmin(request);
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
    return store.listSaves();
  });

  app.delete('/api/saves', async (request, reply) => {
    try {
      requireAdmin(request);
      const result = await runtime.deleteAllSaves();
      return { ok: true, ...result };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.delete<{ Params: { saveId: string } }>('/api/saves/:saveId', async (request, reply) => {
    try {
      requireAdmin(request);
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
        requireAdmin(request);
        await runtime.deleteScenario(request.params.scenarioId);
        return { ok: true };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  app.get('/api/games', async (request, reply) => {
    try {
      requireAdmin(request);
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
    return runtime.listActiveGames();
  });

  app.post<{ Body: { scenarioId: string; name?: string } }>('/api/games', async (request, reply) => {
    try {
      requireAdmin(request);
      const { scenarioId, name } = request.body ?? {};
      if (!scenarioId) {
        return reply.code(400).send({ error: 'scenarioId required' });
      }
      const save = await runtime.createFromScenario(scenarioId, name);
      return {
        gameId: save.id,
        name: save.name,
        stateVersion: save.stateVersion,
        vesselLinks: save.units.map((u) => {
          const playerVessel = isV1PlayerUnit(u);
          return {
            unitId: u.id,
            name: u.name,
            accessToken: u.accessToken,
            passwordProtected: Boolean(u.password),
            playerVessel,
            stations: playerVessel
              ? u.stations.map((s) => ({
                  stationId: s.id,
                  name: s.name,
                  path: `/g/${save.id}/v/${u.accessToken}/s/${s.id}`,
                }))
              : [],
          };
        }),
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { saveId: string } }>('/api/saves/:saveId/load', async (request, reply) => {
    try {
      requireAdmin(request);
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
    Body: {
      course?: number;
      eot?: EotSetting;
      depth?: number;
      fireTorpedo?: {
        room?: 'forward' | 'aft';
        aimHeading: number;
        estimatedCourse: number;
        estimatedSpeedKn: number;
        estimatedRangeNm: number;
        estimatedLengthM: number;
        spreadCount?: number;
        spreadDeg?: number;
      } | null;
      dropDepthCharges?: {
        pattern: 'single' | 'pair' | 'pattern_3' | 'pattern_5';
        depthSettingM: number;
      } | null;
    };
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

  app.post<{
    Params: { gameId: string; formationId: string };
    Body: { course?: number; eot?: EotSetting };
  }>('/api/games/:gameId/formations/:formationId/orders', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const save = runtime.submitFormationOrders(
        request.params.gameId,
        request.params.formationId,
        {
          course: request.body?.course,
          eot: request.body?.eot,
        },
      );
      const formation = save.formations?.find((f) => f.id === request.params.formationId);
      return {
        ok: true,
        stateVersion: save.stateVersion,
        formation,
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string; unitId: string };
    Body: {
      course?: number;
      eot?: EotSetting;
      breakFormation?: boolean;
      rejoinFormation?: boolean;
    };
  }>('/api/games/:gameId/units/:unitId/orders', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const body = request.body ?? {};
      const save = runtime.submitUmpireUnitOrders(request.params.gameId, request.params.unitId, {
        course: body.course,
        eot: body.eot,
        breakFormation: Boolean(body.breakFormation),
        rejoinFormation: Boolean(body.rejoinFormation),
      });
      const unit = save.units.find((u) => u.id === request.params.unitId);
      return {
        ok: true,
        stateVersion: save.stateVersion,
        orders: unit?.orders,
        orderedCourse: unit?.orderedCourse,
        formationId: unit?.formationId,
        formationDetached: Boolean(unit?.formationDetached),
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { enabled: boolean };
  }>('/api/games/:gameId/active-sonar', async (request, reply) => {
    try {
      const session = requireSession(request, request.params.gameId);
      if (session.role !== 'vessel' || !session.unitId || !session.stationId) {
        return reply.code(403).send({ error: 'Vessel station session required' });
      }
      const enabled = Boolean(request.body?.enabled);
      const save = runtime.setActiveSonar(
        session.gameId,
        session.unitId,
        session.stationId,
        enabled,
      );
      const unit = save.units.find((u) => u.id === session.unitId);
      return {
        ok: true,
        stateVersion: save.stateVersion,
        activeSonarEnabled: Boolean(unit?.activeSonarEnabled),
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { raised: boolean; exposure?: number };
  }>('/api/games/:gameId/periscope', async (request, reply) => {
    try {
      const session = requireSession(request, request.params.gameId);
      if (session.role !== 'vessel' || !session.unitId || !session.stationId) {
        return reply.code(403).send({ error: 'Vessel station session required' });
      }
      const raised = Boolean(request.body?.raised);
      const exposureRaw = request.body?.exposure;
      const exposure =
        exposureRaw === undefined || exposureRaw === null
          ? undefined
          : Number(exposureRaw);
      if (exposure !== undefined && !Number.isFinite(exposure)) {
        return reply.code(400).send({ error: 'exposure must be a number 0–1' });
      }
      const save = runtime.setPeriscope(
        session.gameId,
        session.unitId,
        session.stationId,
        raised,
        exposure,
      );
      const unit = save.units.find((u) => u.id === session.unitId);
      return {
        ok: true,
        stateVersion: save.stateVersion,
        periscopeRaised: Boolean(unit?.periscopeRaised),
        periscopeExposure: unit?.periscopeExposure ?? 0,
        plotStampTurns: unit?.plotStampTurns ?? 0,
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string };
    Body: { room?: string };
  }>('/api/games/:gameId/torpedo-reload', async (request, reply) => {
    try {
      const session = requireSession(request, request.params.gameId);
      if (session.role !== 'vessel' || !session.unitId || !session.stationId) {
        return reply.code(403).send({ error: 'Vessel station session required' });
      }
      const room = request.body?.room === 'aft' ? 'aft' : 'forward';
      const save = runtime.startTorpedoReload(
        session.gameId,
        session.unitId,
        session.stationId,
        room,
      );
      const unit = save.units.find((u) => u.id === session.unitId);
      return {
        ok: true,
        stateVersion: save.stateVersion,
        room,
        torpedoForward: unit?.torpedoForward ?? 0,
        torpedoAft: unit?.torpedoAft ?? 0,
        torpedoForwardAwaitingReload: Boolean(unit?.torpedoForwardAwaitingReload),
        torpedoAftAwaitingReload: Boolean(unit?.torpedoAftAwaitingReload),
        torpedoForwardReloadTurnsRemaining: unit?.torpedoForwardReloadTurnsRemaining ?? 0,
        torpedoAftReloadTurnsRemaining: unit?.torpedoAftReloadTurnsRemaining ?? 0,
      };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{ Params: { gameId: string } }>(
    '/api/games/:gameId/depth-charge-reload',
    async (request, reply) => {
      try {
        const session = requireSession(request, request.params.gameId);
        if (session.role !== 'vessel' || !session.unitId || !session.stationId) {
          return reply.code(403).send({ error: 'Vessel station session required' });
        }
        const save = runtime.startDepthChargeReload(
          session.gameId,
          session.unitId,
          session.stationId,
        );
        const unit = save.units.find((u) => u.id === session.unitId);
        return {
          ok: true,
          stateVersion: save.stateVersion,
          depthChargeLoad: unit?.depthChargeLoad ?? 0,
          depthChargeAwaitingReload: Boolean(unit?.depthChargeAwaitingReload),
          depthChargeReloadTurnsRemaining: unit?.depthChargeReloadTurnsRemaining ?? 0,
        };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );

  // --- Live-museum gopher tasks (umpire fiat errand + field-phone verify) ---
  app.post<{
    Params: { gameId: string };
    Body: { unitIds?: string[]; allVessels?: boolean; text: string; label?: string };
  }>('/api/games/:gameId/gopher-task', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const body = request.body ?? ({} as { text?: string });
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) {
        return reply.code(400).send({ error: 'text required' });
      }
      const save = runtime.requireGame(request.params.gameId);
      const unitIds = body.allVessels
        ? save.units.filter((u) => isV1PlayerUnit(u)).map((u) => u.id)
        : Array.isArray(body.unitIds)
          ? body.unitIds
          : [];
      if (!unitIds.length) {
        return reply.code(400).send({ error: 'unitIds or allVessels required' });
      }
      const updated = runtime.pushGopherTask(request.params.gameId, unitIds, text, body.label);
      return { ok: true, stateVersion: updated.stateVersion };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

  app.post<{
    Params: { gameId: string; unitId: string };
    Body: { outcome: 'completed' | 'cleared' | 'failed' };
  }>('/api/games/:gameId/units/:unitId/gopher-task/resolve', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const outcome = request.body?.outcome;
      if (outcome !== 'completed' && outcome !== 'cleared' && outcome !== 'failed') {
        return reply.code(400).send({ error: 'outcome must be completed | cleared | failed' });
      }
      const save = runtime.resolveGopherTask(request.params.gameId, request.params.unitId, outcome);
      const unit = save.units.find((u) => u.id === request.params.unitId);
      return { ok: true, stateVersion: save.stateVersion, gopherTask: unit?.gopherTask };
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
      /** Standing helm course (gradual turn); preferred over fiat heading for Navigation. */
      orderedCourse?: number;
      speed?: number;
      name?: string;
      password?: string;
      type?: string;
      class?: string;
      faction?: string;
      flightLevel?: string;
      condition?: string;
      subsystems?: {
        propulsion?: string;
        sensors?: string;
        radar?: string;
        hydrophone?: string;
        activeSonar?: string;
        lookout?: string;
        steering?: string;
        divePlanes?: string;
        rudderStuckHeading?: number;
        divePlanesStuckDepth?: number;
      };
      position?: { lat?: number; lon?: number; depth?: number };
    };
  }>('/api/games/:gameId/units/:unitId', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const body = request.body ?? {};
      const save = runtime.updateUnit(request.params.gameId, request.params.unitId, {
        health: body.health,
        heading: body.heading,
        orderedCourse: body.orderedCourse,
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
              propulsion: body.subsystems.propulsion as PropulsionState | undefined,
              sensors: body.subsystems.sensors as SubsystemState | undefined,
              radar: body.subsystems.radar as SubsystemState | undefined,
              hydrophone: body.subsystems.hydrophone as SubsystemState | undefined,
              activeSonar: body.subsystems.activeSonar as SubsystemState | undefined,
              lookout: body.subsystems.lookout as SubsystemState | undefined,
              steering: body.subsystems.steering as SteeringState | undefined,
              divePlanes: body.subsystems.divePlanes as DivePlanesState | undefined,
              rudderStuckHeading: body.subsystems.rudderStuckHeading,
              divePlanesStuckDepth: body.subsystems.divePlanesStuckDepth,
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

  app.post<{
    Params: { gameId: string };
    Body: { turnNumber: number; note?: string };
  }>('/api/games/:gameId/turn-notes', async (request, reply) => {
    try {
      requireUmpire(request, request.params.gameId);
      const turnNumber = Number(request.body?.turnNumber);
      if (!Number.isFinite(turnNumber)) {
        return reply.code(400).send({ error: 'turnNumber required' });
      }
      const note = typeof request.body?.note === 'string' ? request.body.note : '';
      const save = runtime.setTurnNote(request.params.gameId, turnNumber, note);
      const snap = save.history.find((h) => h.turnNumber === turnNumber);
      return { ok: true, stateVersion: save.stateVersion, umpireNote: snap?.umpireNote ?? '' };
    } catch (err) {
      const e = httpError(err);
      return reply.code(e.statusCode).send({ error: e.message });
    }
  });

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

  app.post<{ Params: { gameId: string; unitId: string } }>(
    '/api/games/:gameId/units/:unitId/rearm',
    async (request, reply) => {
      try {
        requireUmpire(request, request.params.gameId);
        const save = runtime.rearmUnit(request.params.gameId, request.params.unitId);
        const unit = save.units.find((u) => u.id === request.params.unitId);
        return {
          ok: true,
          stateVersion: save.stateVersion,
          torpedoLoad: unit?.torpedoLoad ?? 0,
          torpedoForward: unit?.torpedoForward ?? 0,
          torpedoAft: unit?.torpedoAft ?? 0,
          depthChargeLoad: unit?.depthChargeLoad ?? 0,
        };
      } catch (err) {
        const e = httpError(err);
        return reply.code(e.statusCode).send({ error: e.message });
      }
    },
  );
}
