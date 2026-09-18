import { nanoid } from 'nanoid';
import {
  DEFAULT_TURN_SECONDS,
  SCHEMA_VERSION,
  defaultRadarSignature,
  defaultSensors,
  normalizeHeading,
  normalizePositionForType,
  resolveCondition,
  resolveFaction,
  resolveFlightLevel,
  resolveStartGameTimeSeconds,
  resolveSubsystems,
  resolveTurnLengthSeconds,
  resolveTurnRate,
  resolveVesselIdentity,
  sideFromFaction,
  type EotSetting,
  type GameSave,
  type HullClass,
  type Scenario,
  type UnitState,
} from '@war-patrol/shared';
import * as store from '../store/fileStore.js';
import { SessionStore } from './sessions.js';
import { SseHub } from './sse.js';
import {
  mergeOrders,
  resolveTurn,
  rollbackToTurn,
  setTimerDeadline,
} from './turnEngine.js';
import { buildViewForSession } from './views.js';

function unitFromScenario(seed: Scenario['units'][number]): UnitState {
  const identity = resolveVesselIdentity({
    type: seed.type,
    class: seed.class,
    classId: seed.classId,
  });
  const radarSignature = seed.radarSignature ?? defaultRadarSignature(identity.class);
  const heading = normalizeHeading(seed.heading);
  const condition = resolveCondition(seed.condition);
  const subsystems = resolveSubsystems(seed.subsystems);
  const flightLevel = resolveFlightLevel(identity.type, seed.flightLevel);
  const faction = resolveFaction({
    faction: seed.faction,
    side: seed.side,
    class: identity.class,
  });
  return normalizeUnit({
    id: seed.id,
    name: seed.name,
    side: sideFromFaction(faction),
    faction,
    classId: seed.classId,
    type: identity.type,
    class: identity.class,
    position: normalizePositionForType(identity.type, { ...seed.position }),
    flightLevel,
    condition,
    subsystems,
    heading,
    orderedCourse: normalizeHeading(seed.orderedCourse ?? seed.heading),
    speed: seed.speed,
    eot: seed.eot ?? 'stop',
    accessToken: seed.accessToken,
    password: seed.password,
    stations: seed.stations.map((s) => ({ ...s, capabilities: [...s.capabilities] })),
    health: seed.health ?? 100,
    orders: {},
    maxSpeed: seed.maxSpeed ?? 20,
    turnRate: resolveTurnRate({
      turnRate: seed.turnRate,
      radarSignature,
      class: identity.class,
      type: identity.type,
    }),
    radarSignature,
    sensors: seed.sensors ? seed.sensors.map((s) => ({ ...s })) : defaultSensors(identity.class),
  });
}

/** Fill missing sensor / signature / course / identity / damage fields for older saves. */
function normalizeUnit(unit: UnitState): UnitState {
  const identity = resolveVesselIdentity({
    type: unit.type,
    class: (unit as UnitState & { class?: HullClass }).class,
    classId: unit.classId,
  });
  const sensors = unit.sensors ?? defaultSensors(identity.class);
  const stations = unit.stations.map((s) => ({ ...s, capabilities: [...s.capabilities] }));
  const hasRadarSensor = sensors.some((s) => s.kind === 'radar');
  // Destroyers, cruisers, and (Wade) submarines with radar get a dedicated Radar station.
  if (
    hasRadarSensor &&
    !stations.some((s) => s.capabilities.includes('radar'))
  ) {
    stations.push({ id: 'radar', name: 'Radar', capabilities: ['radar'] });
  }
  const radarSignature = unit.radarSignature ?? defaultRadarSignature(identity.class);
  const heading = normalizeHeading(unit.heading);
  const orderedCourse =
    typeof unit.orderedCourse === 'number'
      ? normalizeHeading(unit.orderedCourse)
      : heading;
  const condition = resolveCondition(unit.condition);
  const subsystems = resolveSubsystems(unit.subsystems);
  const flightLevel = resolveFlightLevel(identity.type, unit.flightLevel);
  const faction = resolveFaction({
    faction: unit.faction,
    side: unit.side,
    class: identity.class,
  });
  const position = normalizePositionForType(identity.type, { ...unit.position });
  let speed = unit.speed;
  let eot = unit.eot;
  if (condition === 'sunk' || subsystems.propulsion === 'disabled') {
    speed = 0;
    eot = 'stop';
  }
  return {
    ...unit,
    side: sideFromFaction(faction),
    faction,
    type: identity.type,
    class: identity.class,
    position,
    flightLevel,
    condition,
    subsystems,
    heading,
    orderedCourse,
    speed,
    eot,
    radarSignature,
    turnRate: resolveTurnRate({
      turnRate: unit.turnRate,
      radarSignature,
      class: identity.class,
      type: identity.type,
    }),
    sensors,
    stations,
  };
}

function normalizeSave(save: GameSave): GameSave {
  const units = save.units.map((u) => normalizeUnit(structuredClone(u)));
  const turnLengthSeconds = resolveTurnLengthSeconds(save.turnLengthSeconds);
  const gameTimeSeconds =
    typeof save.turn?.gameTimeSeconds === 'number'
      ? save.turn.gameTimeSeconds
      : resolveStartGameTimeSeconds(undefined);
  const startTrails =
    save.startTrails ??
    units.map((u) => ({
      unitId: u.id,
      points: [{ lat: u.position.lat, lon: u.position.lon, turnNumber: 0 }],
    }));
  return {
    ...save,
    turnLengthSeconds,
    startTrails,
    turn: {
      ...save.turn,
      gameTimeSeconds,
    },
    units,
    history: (save.history ?? []).map((h) => ({
      ...h,
      gameTimeSeconds: h.gameTimeSeconds ?? h.turn?.gameTimeSeconds ?? gameTimeSeconds,
      turn: {
        ...h.turn,
        gameTimeSeconds: h.turn?.gameTimeSeconds ?? h.gameTimeSeconds ?? gameTimeSeconds,
      },
      units: h.units.map((u) => normalizeUnit(structuredClone(u))),
    })),
  };
}

export class GameRuntime {
  readonly sessions = new SessionStore();
  readonly sse = new SseHub();
  /** Active in-memory games keyed by save/game id. */
  private games = new Map<string, GameSave>();
  private timerHandles = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.sse.setViewBuilder((client) => {
      const save = this.games.get(client.gameId);
      if (!save) return null;
      return buildViewForSession(save, this.sse, client.role, client.unitId, client.stationId);
    });
    // Connection join/leave should refresh umpire (and station multi-connect) without a turn bump.
    this.sse.onConnectionsChanged = (gameId) => {
      const save = this.games.get(gameId);
      if (!save) return;
      this.sse.broadcast(gameId, save.stateVersion);
    };
  }

  getGame(gameId: string): GameSave | undefined {
    return this.games.get(gameId);
  }

  requireGame(gameId: string): GameSave {
    const g = this.games.get(gameId);
    if (!g) throw Object.assign(new Error('Game not found'), { statusCode: 404 });
    return g;
  }

  listActiveGames(): Array<{ id: string; name: string; stateVersion: number }> {
    return [...this.games.values()].map((g) => ({
      id: g.id,
      name: g.name,
      stateVersion: g.stateVersion,
    }));
  }

  async createFromScenario(scenarioId: string, name?: string): Promise<GameSave> {
    const scenario = await store.loadScenario(scenarioId);
    const now = new Date().toISOString();
    const units = scenario.units.map(unitFromScenario);
    const turnLengthSeconds = resolveTurnLengthSeconds(scenario.turnLengthSeconds);
    const gameTimeSeconds = resolveStartGameTimeSeconds(scenario.startGameTimeSeconds);
    const save: GameSave = {
      schemaVersion: SCHEMA_VERSION,
      id: nanoid(12),
      name: name?.trim() || scenario.name,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      mode: scenario.mode,
      operatingArea: { ...scenario.operatingArea },
      umpirePassword: scenario.umpirePassword,
      createdAt: now,
      updatedAt: now,
      stateVersion: 1,
      turnLengthSeconds,
      turn: {
        number: 1,
        phase: 'open',
        timerDeadline: null,
        timerSeconds: scenario.defaultTurnSeconds ?? DEFAULT_TURN_SECONDS,
        gameTimeSeconds,
      },
      startTrails: units.map((u) => ({
        unitId: u.id,
        points: [{ lat: u.position.lat, lon: u.position.lon, turnNumber: 0 }],
      })),
      units,
      history: [],
    };
    this.games.set(save.id, save);
    await store.writeSave(save);
    return save;
  }

  async loadSaveIntoMemory(saveId: string): Promise<GameSave> {
    const save = normalizeSave(await store.loadSave(saveId));
    this.sessions.clearGame(save.id);
    this.clearTimer(save.id);
    this.games.set(save.id, save);
    this.bumpAndBroadcast(save.id);
    return save;
  }

  async persist(gameId: string): Promise<GameSave> {
    const save = this.requireGame(gameId);
    save.updatedAt = new Date().toISOString();
    await store.writeSave(save);
    return save;
  }

  /** Unload an in-memory game: timers, sessions, SSE, map entry — no disk write. */
  unloadGame(gameId: string): boolean {
    if (!this.games.has(gameId)) return false;
    this.clearTimer(gameId);
    this.sessions.clearGame(gameId);
    this.sse.dropGame(gameId);
    this.games.delete(gameId);
    return true;
  }

  /**
   * Delete a save file and drop any in-memory copy / sessions (no orphans).
   * Returns false if the file was already missing (still unloads memory if present).
   */
  async deleteSave(saveId: string): Promise<{ deletedFile: boolean; unloaded: boolean }> {
    const unloaded = this.unloadGame(saveId);
    const deletedFile = await store.deleteSaveFile(saveId);
    if (!deletedFile && !unloaded) {
      throw Object.assign(new Error('Save not found'), { statusCode: 404 });
    }
    return { deletedFile, unloaded };
  }

  /** Delete a scenario JSON file from disk. */
  async deleteScenario(scenarioId: string): Promise<void> {
    const ok = await store.deleteScenarioFile(scenarioId);
    if (!ok) {
      throw Object.assign(new Error('Scenario not found'), { statusCode: 404 });
    }
  }

  private replace(gameId: string, next: GameSave): GameSave {
    this.games.set(gameId, next);
    return next;
  }

  bumpAndBroadcast(gameId: string): void {
    const save = this.requireGame(gameId);
    this.sse.broadcast(gameId, save.stateVersion);
  }

  private touch(gameId: string, mutator: (save: GameSave) => GameSave): GameSave {
    const current = this.requireGame(gameId);
    const next = mutator(structuredClone(current));
    next.stateVersion = current.stateVersion + 1;
    next.updatedAt = new Date().toISOString();
    this.replace(gameId, next);
    this.sse.broadcast(gameId, next.stateVersion);
    return next;
  }

  authUmpire(gameId: string, password: string) {
    const save = this.requireGame(gameId);
    const expected = save.umpirePassword ?? '';
    if (expected && password !== expected) {
      throw Object.assign(new Error('Invalid umpire password'), { statusCode: 401 });
    }
    return this.sessions.create({ gameId, role: 'umpire' });
  }

  authVessel(gameId: string, accessToken: string, password: string | undefined, stationId: string) {
    const save = this.requireGame(gameId);
    const unit = save.units.find((u) => u.accessToken === accessToken);
    if (!unit) {
      throw Object.assign(new Error('Unknown vessel token'), { statusCode: 404 });
    }
    if (unit.password && unit.password !== (password ?? '')) {
      throw Object.assign(new Error('Invalid vessel password'), { statusCode: 401 });
    }
    const station = unit.stations.find((s) => s.id === stationId);
    if (!station) {
      throw Object.assign(new Error('Unknown station'), { statusCode: 404 });
    }
    return this.sessions.create({
      gameId,
      role: 'vessel',
      unitId: unit.id,
      stationId,
    });
  }

  submitOrders(
    gameId: string,
    unitId: string,
    stationId: string,
    patch: { course?: number; eot?: EotSetting },
  ): GameSave {
    return this.touch(gameId, (save) => {
      if (save.turn.phase !== 'open') {
        throw Object.assign(new Error('Ordering is locked'), { statusCode: 409 });
      }
      const unit = save.units.find((u) => u.id === unitId);
      if (!unit) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const station = unit.stations.find((s) => s.id === stationId);
      if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });

      if (patch.course !== undefined && !station.capabilities.includes('helm')) {
        throw Object.assign(new Error('Station cannot set course'), { statusCode: 403 });
      }
      if (patch.eot !== undefined && !station.capabilities.includes('engineering') && !station.capabilities.includes('helm')) {
        // Allow helm OR engineering to set EOT for Phase 1 usability on bridge/conn
        throw Object.assign(new Error('Station cannot set EOT'), { statusCode: 403 });
      }

      unit.orders = mergeOrders(unit.orders, patch, stationId);
      // Steering course is live as soon as helm rings it up (persists across turns).
      if (patch.course !== undefined) {
        unit.orderedCourse = normalizeHeading(patch.course);
      }
      return save;
    });
  }

  setTimer(gameId: string, seconds: number): GameSave {
    this.clearTimer(gameId);
    const save = this.touch(gameId, (s) => {
      s.turn.timerSeconds = seconds;
      if (s.turn.phase === 'open') {
        s.turn.timerDeadline = setTimerDeadline(seconds);
      }
      return s;
    });
    this.armTimer(gameId);
    return save;
  }

  extendTimer(gameId: string, extraSeconds: number): GameSave {
    this.clearTimer(gameId);
    const save = this.touch(gameId, (s) => {
      const base = s.turn.timerDeadline
        ? Math.max(Date.now(), Date.parse(s.turn.timerDeadline))
        : Date.now();
      s.turn.timerDeadline = setTimerDeadline(extraSeconds, base);
      s.turn.timerSeconds = s.turn.timerSeconds + extraSeconds;
      return s;
    });
    this.armTimer(gameId);
    return save;
  }

  resetTimer(gameId: string): GameSave {
    this.clearTimer(gameId);
    const save = this.touch(gameId, (s) => {
      if (s.turn.phase === 'open') {
        s.turn.timerDeadline = setTimerDeadline(s.turn.timerSeconds);
      } else {
        s.turn.timerDeadline = null;
      }
      return s;
    });
    this.armTimer(gameId);
    return save;
  }

  lockTurn(gameId: string): GameSave {
    this.clearTimer(gameId);
    return this.touch(gameId, (s) => {
      if (s.turn.phase !== 'open') {
        throw Object.assign(new Error('Turn is not open'), { statusCode: 409 });
      }
      s.turn.phase = 'locked';
      s.turn.timerDeadline = null;
      return s;
    });
  }

  reopenTurn(gameId: string): GameSave {
    this.clearTimer(gameId);
    const save = this.touch(gameId, (s) => {
      if (s.turn.phase !== 'locked' && s.turn.phase !== 'awaiting_resolution') {
        throw Object.assign(new Error('Turn cannot be reopened'), { statusCode: 409 });
      }
      s.turn.phase = 'open';
      s.turn.timerDeadline = null;
      return s;
    });
    return save;
  }

  async resolve(gameId: string): Promise<GameSave> {
    this.clearTimer(gameId);
    const current = this.requireGame(gameId);
    if (current.turn.phase !== 'locked' && current.turn.phase !== 'awaiting_resolution' && current.turn.phase !== 'open') {
      throw Object.assign(new Error('Cannot resolve turn'), { statusCode: 409 });
    }
    // Allow resolve from open (umpire force) or locked
    const prepared =
      current.turn.phase === 'open'
        ? this.touch(gameId, (s) => {
            s.turn.phase = 'locked';
            s.turn.timerDeadline = null;
            return s;
          })
        : current;

    const resolved = resolveTurn(structuredClone(prepared));
    this.replace(gameId, resolved);
    this.sse.broadcast(gameId, resolved.stateVersion);
    await store.writeSave(resolved);
    return resolved;
  }

  /**
   * Rollback requires explicit confirmation (ARCH-SM-13):
   * `confirm` must be `"ROLLBACK"` or the target turn number as a string.
   */
  async rollback(gameId: string, turnNumber: number, confirm: string): Promise<GameSave> {
    const expectedTurn = String(turnNumber);
    const normalized = confirm.trim().toUpperCase();
    if (normalized !== 'ROLLBACK' && confirm.trim() !== expectedTurn) {
      throw Object.assign(
        new Error('Rollback requires confirm: "ROLLBACK" or the target turn number'),
        { statusCode: 400 },
      );
    }
    this.clearTimer(gameId);
    const next = rollbackToTurn(this.requireGame(gameId), turnNumber);
    this.replace(gameId, next);
    this.sse.broadcast(gameId, next.stateVersion);
    await store.writeSave(next);
    return next;
  }

  updateUnit(
    gameId: string,
    unitId: string,
    patch: Partial<
      Pick<
        UnitState,
        | 'health'
        | 'heading'
        | 'speed'
        | 'name'
        | 'password'
        | 'type'
        | 'class'
        | 'flightLevel'
        | 'condition'
        | 'faction'
      >
    > & {
      position?: Partial<UnitState['position']>;
      subsystems?: Partial<UnitState['subsystems']>;
    },
  ): GameSave {
    return this.touch(gameId, (save) => {
      const idx = save.units.findIndex((u) => u.id === unitId);
      if (idx < 0) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const unit = save.units[idx]!;
      if (patch.health !== undefined) unit.health = patch.health;
      if (patch.heading !== undefined) unit.heading = patch.heading;
      if (patch.speed !== undefined) unit.speed = patch.speed;
      if (patch.name !== undefined) unit.name = patch.name;
      if (patch.password !== undefined) unit.password = patch.password || undefined;
      if (patch.position) {
        unit.position = { ...unit.position, ...patch.position };
      }
      if (patch.type !== undefined || patch.class !== undefined) {
        const identity = resolveVesselIdentity({
          type: patch.type ?? unit.type,
          class: patch.class ?? unit.class,
          classId: unit.classId,
        });
        unit.type = identity.type;
        unit.class = identity.class;
      }
      if (patch.faction !== undefined) {
        unit.faction = resolveFaction({ faction: patch.faction, class: unit.class });
        unit.side = sideFromFaction(unit.faction);
      }
      if (patch.flightLevel !== undefined) {
        unit.flightLevel = patch.flightLevel;
      }
      if (patch.condition !== undefined) {
        unit.condition = resolveCondition(patch.condition);
      }
      if (patch.subsystems) {
        unit.subsystems = resolveSubsystems({
          ...unit.subsystems,
          ...patch.subsystems,
        });
      }
      // Re-normalize so type rules (surface depth, flight level, dead-in-water) stick.
      save.units[idx] = normalizeUnit(unit);
      return save;
    });
  }

  setUmpirePassword(gameId: string, password: string): GameSave {
    return this.touch(gameId, (s) => {
      s.umpirePassword = password || undefined;
      return s;
    });
  }

  rotateAccessToken(gameId: string, unitId: string): GameSave {
    return this.touch(gameId, (s) => {
      const unit = s.units.find((u) => u.id === unitId);
      if (!unit) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      unit.accessToken = nanoid(10);
      return s;
    });
  }

  private clearTimer(gameId: string): void {
    const h = this.timerHandles.get(gameId);
    if (h) clearTimeout(h);
    this.timerHandles.delete(gameId);
  }

  private armTimer(gameId: string): void {
    this.clearTimer(gameId);
    const save = this.games.get(gameId);
    if (!save?.turn.timerDeadline || save.turn.phase !== 'open') return;
    const ms = Date.parse(save.turn.timerDeadline) - Date.now();
    if (ms <= 0) {
      void this.lockTurn(gameId);
      return;
    }
    const handle = setTimeout(() => {
      try {
        const g = this.games.get(gameId);
        if (g && g.turn.phase === 'open') this.lockTurn(gameId);
      } catch {
        /* ignore */
      }
    }, ms);
    this.timerHandles.set(gameId, handle);
  }
}

export const runtime = new GameRuntime();
