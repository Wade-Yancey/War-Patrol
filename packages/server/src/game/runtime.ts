import { nanoid } from 'nanoid';
import {
  DEFAULT_TURN_SECONDS,
  SCHEMA_VERSION,
  clampSpeedToMax,
  clampSubmarineDepth,
  defaultBeamM,
  defaultLengthM,
  defaultMaxSpeed,
  defaultRadarSignature,
  defaultSensors,
  defaultTwoScreenStations,
  resolveTorpedoMagazineState,
  resolveDepthChargeMagazineState,
  rearmUnitWeapons,
  startTorpedoRoomReload,
  startDepthChargeReload as beginDepthChargeRackReload,
  normalizeTorpedoRoomId,
  canFireTorpedoFromRoom,
  canDropDepthCharges,
  torpedoRoomReady,
  checkTorpedoOrderArc,
  formatTorpedoArcRejectMessage,
  type TorpedoRoomId,
  effectiveMaxSpeed,
  hasActiveSonarSensor,
  hasLookoutSensor,
  canUseLookoutOptics,
  isPeriscopeDepthOk,
  clampPeriscopeExposure,
  PERISCOPE_DEPTH_M,
  PERISCOPE_EXPOSURE_DEFAULT,
  isTwoScreenStationLayout,
  normalizeHeading,
  normalizePositionForType,
  resolveBeamM,
  resolveCondition,
  resolveFaction,
  resolveFlightLevel,
  resolveLengthM,
  resolveMaxSpeed,
  resolveOrderedDepth,
  resolveStartGameTimeSeconds,
  resolveSubsystems,
  propulsionSpeedFactor,
  resolveTurnLengthSeconds,
  resolveTurnRate,
  resolveVesselIdentity,
  sideFromFaction,
  isV1PlayerUnit,
  normalizeContactBook,
  type CombatLogEntry,
  type EotSetting,
  type GameSave,
  type GopherTask,
  type HullClass,
  type Scenario,
  type TurnSnapshot,
  type SubsystemState,
  type UnitState,
} from '@war-patrol/shared';
import * as store from '../store/fileStore.js';
import { SessionStore } from './sessions.js';
import { SseHub } from './sse.js';
import {
  captureOpeningSnapshot,
  mergeOrders,
  resolveTurn,
  rollbackToTurn,
  setTimerDeadline,
} from './turnEngine.js';
import { appendCombatLog, logLine } from './weaponsResolve.js';
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
    orderedDepth: resolveOrderedDepth(
      identity.type,
      seed.position.depth,
      seed.orderedDepth,
    ),
    speed: seed.speed,
    eot: seed.eot ?? 'stop',
    accessToken: seed.accessToken,
    password: seed.password,
    stations: seed.stations.map((s) => ({ ...s, capabilities: [...s.capabilities] })),
    health: seed.health ?? 100,
    orders: {},
    maxSpeed: resolveMaxSpeed({
      maxSpeed: seed.maxSpeed,
      class: identity.class,
      type: identity.type,
    }),
    lengthM: resolveLengthM({
      lengthM: seed.lengthM,
      class: identity.class,
      type: identity.type,
    }),
    beamM: resolveBeamM({
      beamM: seed.beamM,
      class: identity.class,
      type: identity.type,
    }),
    turnRate: resolveTurnRate({
      turnRate: seed.turnRate,
      radarSignature,
      class: identity.class,
      type: identity.type,
    }),
    radarSignature,
    sensors: seed.sensors ? seed.sensors.map((s) => ({ ...s })) : defaultSensors(identity.class),
    activeSonarEnabled: Boolean(seed.activeSonarEnabled),
    periscopeRaised:
      identity.type === 'Submarine' ? Boolean(seed.periscopeRaised) : false,
    periscopeExposure:
      identity.type === 'Submarine' && seed.periscopeRaised
        ? clampPeriscopeExposure(
            seed.periscopeExposure ?? PERISCOPE_EXPOSURE_DEFAULT,
            { allowZero: false },
          )
        : 0,
    plotStampTurns:
      identity.type === 'Submarine'
        ? Math.max(0, Math.floor(Number(seed.plotStampTurns) || 0))
        : 0,
    ...resolveTorpedoMagazineState({
      ...identity,
      torpedoLoad: seed.torpedoLoad,
      torpedoForward: seed.torpedoForward,
      torpedoAft: seed.torpedoAft,
    }),
    ...resolveDepthChargeMagazineState({
      ...identity,
      depthChargeLoad: seed.depthChargeLoad,
    }),
  });
}

/** Fill missing sensor / signature / course / identity / damage fields for older saves. */
function normalizeUnit(unit: UnitState): UnitState {
  const identity = resolveVesselIdentity({
    type: unit.type,
    class: (unit as UnitState & { class?: HullClass }).class,
    classId: unit.classId,
  });
  const contactBook = normalizeContactBook(unit.contactBook);
  let sensors = unit.sensors ?? defaultSensors(identity.class);
  // Migrate multi-station layouts → Controls + Sensors; reconcile equipment by class.
  let stations = unit.stations.map((s) => ({ ...s, capabilities: [...s.capabilities] }));
  if (!isTwoScreenStationLayout(stations)) {
    const defaults = defaultTwoScreenStations(identity.class);
    if (defaults.length > 0) {
      stations = defaults.map((s) => ({ ...s, capabilities: [...s.capabilities] }));
    }
  } else {
    // Keep only controls/sensors; refresh capabilities from class defaults when present.
    const defaults = defaultTwoScreenStations(identity.class);
    if (defaults.length > 0) {
      stations = defaults.map((s) => ({ ...s, capabilities: [...s.capabilities] }));
    }
  }

  // Reconcile installed sensors to class defaults for player hulls (DD: no hydrophone;
  // sub: no active sonar; ensure required sets exist).
  const classDefaults = defaultSensors(identity.class);
  if (classDefaults.length > 0) {
    const byKind = new Map(sensors.map((s) => [s.kind, s]));
    for (const d of classDefaults) {
      if (!byKind.has(d.kind)) byKind.set(d.kind, { ...d });
    }
    // Drop sensors that are no longer on this class (e.g. destroyer hydrophone).
    const allowed = new Set(classDefaults.map((s) => s.kind));
    sensors = [...byKind.values()].filter((s) => allowed.has(s.kind));
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
  const orderedDepth = resolveOrderedDepth(identity.type, position.depth, unit.orderedDepth);
  const maxSpeed = resolveMaxSpeed({
    maxSpeed: unit.maxSpeed,
    class: identity.class,
    type: identity.type,
  });
  const lengthM = resolveLengthM({
    lengthM: unit.lengthM,
    class: identity.class,
    type: identity.type,
  });
  const beamM = resolveBeamM({
    beamM: unit.beamM,
    class: identity.class,
    type: identity.type,
  });
  let speed = unit.speed;
  let eot = unit.eot;
  if (condition === 'sunk' || subsystems.propulsion === 'disabled') {
    speed = 0;
    eot = 'stop';
  } else {
    const ceiling =
      effectiveMaxSpeed({
        type: identity.type,
        maxSpeed,
        depth: position.depth,
      }) * propulsionSpeedFactor(subsystems.propulsion);
    speed = clampSpeedToMax(speed, ceiling);
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
    orderedDepth,
    speed,
    eot,
    radarSignature,
    maxSpeed,
    lengthM,
    beamM,
    turnRate: resolveTurnRate({
      turnRate: unit.turnRate,
      radarSignature,
      class: identity.class,
      type: identity.type,
    }),
    sensors,
    stations,
    activeSonarEnabled: hasActiveSonarSensor({ sensors })
      ? Boolean(unit.activeSonarEnabled)
      : false,
    periscopeRaised:
      identity.type === 'Submarine' ? Boolean(unit.periscopeRaised) : false,
    periscopeExposure:
      identity.type === 'Submarine' && unit.periscopeRaised
        ? clampPeriscopeExposure(
            unit.periscopeExposure ?? PERISCOPE_EXPOSURE_DEFAULT,
            { allowZero: false },
          )
        : 0,
    plotStampTurns:
      identity.type === 'Submarine'
        ? Math.max(0, Math.floor(Number(unit.plotStampTurns) || 0))
        : 0,
    ...resolveTorpedoMagazineState(unit),
    ...resolveDepthChargeMagazineState(unit),
    ...(contactBook ? { contactBook } : {}),
  };
}

function normalizeSnapshot(snap: GameSave['history'][number], fallbackClock: number) {
  const clock = snap.gameTimeSeconds ?? snap.turn?.gameTimeSeconds ?? fallbackClock;
  return {
    ...snap,
    gameTimeSeconds: clock,
    turn: {
      ...snap.turn,
      gameTimeSeconds: snap.turn?.gameTimeSeconds ?? clock,
    },
    units: snap.units.map((u) => normalizeUnit(structuredClone(u))),
    torpedoes: snap.torpedoes ?? [],
    depthCharges: snap.depthCharges ?? [],
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
  const turn = {
    ...save.turn,
    gameTimeSeconds,
  };
  const history = (save.history ?? []).map((h) => normalizeSnapshot(h, gameTimeSeconds));
  const torpedoes = save.torpedoes ?? [];
  const depthCharges = save.depthCharges ?? [];
  let openingSnapshot: TurnSnapshot | undefined = save.openingSnapshot
    ? normalizeSnapshot(save.openingSnapshot, gameTimeSeconds)
    : undefined;
  // Still at the start: record it so a later rollback to turn 1 can undo the first resolve.
  if (!openingSnapshot && turn.number === 1 && history.length === 0) {
    openingSnapshot = captureOpeningSnapshot({
      ...save,
      turn,
      units,
      torpedoes,
      depthCharges,
      history,
    });
  }
  return {
    ...save,
    turnLengthSeconds,
    startTrails,
    turn,
    units,
    torpedoes,
    depthCharges,
    recentDetonations: save.recentDetonations ?? [],
    combatLog: save.combatLog ?? [],
    openingSnapshot,
    history,
  };
}

export class GameRuntime {
  readonly sessions = new SessionStore();
  readonly sse = new SseHub();
  /** Active in-memory games keyed by save/game id. */
  private games = new Map<string, GameSave>();
  private timerHandles = new Map<string, NodeJS.Timeout>();
  /**
   * Serialize resolve/rollback per game so overlapping umpire clicks (or double
   * submits) cannot double-advance a turn while `writeSave` is still awaiting.
   */
  private turnMutationTail = new Map<string, Promise<unknown>>();

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

  /** Run resolve/rollback exclusively per gameId (FIFO). */
  private enqueueTurnMutation<T>(gameId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.turnMutationTail.get(gameId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    this.turnMutationTail.set(
      gameId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
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
      torpedoes: [],
      depthCharges: [],
      recentDetonations: [],
      combatLog: [],
      history: [],
    };
    save.openingSnapshot = captureOpeningSnapshot(save);
    // Persist before registering in memory (see resolve()/rollback()): a
    // failed write should not leave a game reachable in memory with no
    // durable save behind it.
    await store.writeSave(save);
    this.games.set(save.id, save);
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
    this.turnMutationTail.delete(gameId);
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

  /**
   * Delete every save on disk and unload matching in-memory games / sessions.
   * Idempotent: empty disk returns deleted=0.
   */
  async deleteAllSaves(): Promise<{ deleted: number; unloaded: number }> {
    const listed = await store.listSaves();
    let unloaded = 0;
    for (const s of listed) {
      if (this.unloadGame(s.id)) unloaded += 1;
    }
    const deleted = await store.deleteAllSaveFiles();
    return { deleted, unloaded };
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
    // v1: only Destroyer + Fleet Submarine have player station flows.
    if (!isV1PlayerUnit(unit)) {
      throw Object.assign(
        new Error('Station join is limited to Destroyer and Fleet Submarine in v1'),
        { statusCode: 403 },
      );
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
    patch: {
      course?: number;
      eot?: EotSetting;
      depth?: number;
      fireTorpedo?: import('@war-patrol/shared').TorpedoFireOrder | null;
      dropDepthCharges?: import('@war-patrol/shared').DepthChargeDropOrder | null;
    },
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
        // Allow helm OR engineering to set EOT for Phase 1 usability on controls
        throw Object.assign(new Error('Station cannot set EOT'), { statusCode: 403 });
      }
      if (patch.depth !== undefined) {
        if (!station.capabilities.includes('helm')) {
          throw Object.assign(new Error('Station cannot set depth'), { statusCode: 403 });
        }
        if (unit.type !== 'Submarine') {
          throw Object.assign(new Error('Only submarines can set depth'), { statusCode: 400 });
        }
      }
      if (patch.fireTorpedo !== undefined && patch.fireTorpedo !== null) {
        if (
          !station.capabilities.includes('weapons') &&
          !station.capabilities.includes('torpedo')
        ) {
          throw Object.assign(new Error('Station cannot fire torpedoes'), { statusCode: 403 });
        }
        if (unit.type !== 'Submarine') {
          throw Object.assign(new Error('Only submarines can fire torpedoes'), { statusCode: 400 });
        }
        const room = normalizeTorpedoRoomId(patch.fireTorpedo.room);
        if (!canFireTorpedoFromRoom(unit, room)) {
          const have = torpedoRoomReady(unit, room);
          if (have <= 0) {
            throw Object.assign(new Error(`No torpedoes remaining in ${room} room`), {
              statusCode: 400,
            });
          }
          throw Object.assign(
            new Error(`${room} room awaiting reload — press Reload and wait`),
            { statusCode: 400 },
          );
        }
        if (!(Number(patch.fireTorpedo.estimatedLengthM) > 0)) {
          throw Object.assign(new Error('Target length estimate required'), { statusCode: 400 });
        }
        if (!(Number(patch.fireTorpedo.estimatedRangeNm) > 0)) {
          throw Object.assign(new Error('Target range estimate required'), { statusCode: 400 });
        }
        const want = Math.max(1, Math.floor(Number(patch.fireTorpedo.spreadCount) || 1));
        if (want > torpedoRoomReady(unit, room)) {
          throw Object.assign(new Error('Not enough torpedoes for that spread'), {
            statusCode: 400,
          });
        }
        const arc = checkTorpedoOrderArc({
          ownHeadingDeg: unit.heading,
          room,
          aimHeading: Number(patch.fireTorpedo.aimHeading) || 0,
          estimatedCourse: Number(patch.fireTorpedo.estimatedCourse) || 0,
          estimatedSpeedKn: Number(patch.fireTorpedo.estimatedSpeedKn) || 0,
          estimatedRangeNm: Number(patch.fireTorpedo.estimatedRangeNm) || 0,
          spreadCount: want,
          spreadDeg: patch.fireTorpedo.spreadDeg,
        });
        if (!arc.ok) {
          throw Object.assign(new Error(formatTorpedoArcRejectMessage(arc)), {
            statusCode: 400,
          });
        }
        // Fresh in-arc order supersedes any earlier blocked-salvo notice.
        delete unit.torpedoArcBlock;
      }
      if (patch.dropDepthCharges !== undefined && patch.dropDepthCharges !== null) {
        if (!station.capabilities.includes('weapons')) {
          throw Object.assign(new Error('Station cannot drop depth charges'), { statusCode: 403 });
        }
        if (unit.class !== 'Destroyer') {
          throw Object.assign(new Error('Only destroyers can drop depth charges'), {
            statusCode: 400,
          });
        }
        if (!canDropDepthCharges(unit)) {
          if ((unit.depthChargeLoad ?? 0) <= 0) {
            throw Object.assign(new Error('No depth charges remaining'), { statusCode: 400 });
          }
          throw Object.assign(
            new Error('Depth-charge rack awaiting reload — press Reload and wait'),
            { statusCode: 400 },
          );
        }
      }

      const normalizedPatch = {
        ...patch,
        ...(patch.depth !== undefined ? { depth: clampSubmarineDepth(patch.depth) } : {}),
      };
      unit.orders = mergeOrders(unit.orders, normalizedPatch, stationId);
      // Steering course is live as soon as helm rings it up (persists across turns).
      // Rudder stuck / steering disabled: ignore new course set-points.
      if (
        normalizedPatch.course !== undefined &&
        unit.subsystems?.steering !== 'stuck' &&
        unit.subsystems?.steering !== 'disabled'
      ) {
        unit.orderedCourse = normalizeHeading(normalizedPatch.course);
      }
      // Depth set-point is live; actual depth changes on resolve.
      // Dive planes stuck/disabled: ignore new depth set-points.
      if (
        normalizedPatch.depth !== undefined &&
        unit.subsystems?.divePlanes !== 'stuck' &&
        unit.subsystems?.divePlanes !== 'disabled'
      ) {
        unit.orderedDepth = clampSubmarineDepth(normalizedPatch.depth);
      }
      return save;
    });
  }

  /**
   * Immediate operator toggle for destroyer active search sonar (Sensors station).
   * Not a turn order — applies now and persists until toggled off.
   */
  setActiveSonar(
    gameId: string,
    unitId: string,
    stationId: string,
    enabled: boolean,
  ): GameSave {
    return this.touch(gameId, (save) => {
      const unit = save.units.find((u) => u.id === unitId);
      if (!unit) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const station = unit.stations.find((s) => s.id === stationId);
      if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });
      if (!station.capabilities.includes('active_sonar')) {
        throw Object.assign(new Error('Station cannot control active sonar'), { statusCode: 403 });
      }
      if (!hasActiveSonarSensor(unit)) {
        throw Object.assign(new Error('No active sonar set installed'), { statusCode: 400 });
      }
      unit.activeSonarEnabled = Boolean(enabled);
      return save;
    });
  }

  /**
   * Immediate fleet-sub periscope raise/lower + exposure (Sensors lookout station).
   * Lowering clears optics, zeros exposure, and resets plot stamp (no frozen bonus).
   * Raising only allowed at/above periscope depth with healthy sensors.
   * `exposure` is the fraction of the turn the mast is up (0–1); defaults to full
   * when raising without an explicit value. Any exposure &gt; 0 makes the feather
   * visible to DD lookout in range (deterministic — no spot roll).
   */
  setPeriscope(
    gameId: string,
    unitId: string,
    stationId: string,
    raised: boolean,
    exposure?: number,
  ): GameSave {
    return this.touch(gameId, (save) => {
      const unit = save.units.find((u) => u.id === unitId);
      if (!unit) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const station = unit.stations.find((s) => s.id === stationId);
      if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });
      if (!station.capabilities.includes('lookout')) {
        throw Object.assign(new Error('Station cannot control periscope'), { statusCode: 403 });
      }
      if (unit.type !== 'Submarine') {
        throw Object.assign(new Error('Only submarines have a periscope mast'), { statusCode: 400 });
      }
      if (!hasLookoutSensor(unit)) {
        throw Object.assign(new Error('No periscope set installed'), { statusCode: 400 });
      }
      const opticsOk = canUseLookoutOptics(unit);
      if (!opticsOk.ok) {
        throw Object.assign(
          new Error(
            opticsOk.reason === 'sunk'
              ? 'Unit sunk — periscope offline'
              : 'Sensors disabled — periscope offline',
          ),
          { statusCode: 400 },
        );
      }
      if (raised) {
        const depthOk = isPeriscopeDepthOk(unit);
        if (!depthOk.ok) {
          throw Object.assign(
            new Error(`Too deep to raise periscope (≤ ${PERISCOPE_DEPTH_M} m)`),
            { statusCode: 400 },
          );
        }
        unit.periscopeRaised = true;
        const nextExposure =
          exposure !== undefined
            ? clampPeriscopeExposure(exposure, { allowZero: false })
            : unit.periscopeExposure > 0
              ? clampPeriscopeExposure(unit.periscopeExposure, { allowZero: false })
              : PERISCOPE_EXPOSURE_DEFAULT;
        unit.periscopeExposure = nextExposure;
      } else {
        unit.periscopeRaised = false;
        unit.periscopeExposure = 0;
        unit.plotStampTurns = 0;
      }
      return save;
    });
  }

  /**
   * Immediate Controls action: start a torpedo-room reload countdown after a salvo.
   * Completes over {@link TORPEDO_RELOAD_TURNS} resolves — not an instant rearm.
   */
  startTorpedoReload(
    gameId: string,
    unitId: string,
    stationId: string,
    room: TorpedoRoomId,
  ): GameSave {
    return this.touch(gameId, (save) => {
      const idx = save.units.findIndex((u) => u.id === unitId);
      if (idx < 0) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const unit = save.units[idx]!;
      const station = unit.stations.find((s) => s.id === stationId);
      if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });
      if (
        !station.capabilities.includes('weapons') &&
        !station.capabilities.includes('torpedo')
      ) {
        throw Object.assign(new Error('Station cannot reload torpedoes'), { statusCode: 403 });
      }
      const result = startTorpedoRoomReload(unit, normalizeTorpedoRoomId(room));
      if (!result.ok) {
        throw Object.assign(new Error(result.error), { statusCode: 400 });
      }
      save.units[idx] = result.unit;
      return save;
    });
  }

  /**
   * Immediate Controls action: start a depth-charge rack reload countdown after a drop.
   */
  startDepthChargeReload(
    gameId: string,
    unitId: string,
    stationId: string,
  ): GameSave {
    return this.touch(gameId, (save) => {
      const idx = save.units.findIndex((u) => u.id === unitId);
      if (idx < 0) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const unit = save.units[idx]!;
      const station = unit.stations.find((s) => s.id === stationId);
      if (!station) throw Object.assign(new Error('Station not found'), { statusCode: 404 });
      if (!station.capabilities.includes('weapons')) {
        throw Object.assign(new Error('Station cannot reload depth charges'), { statusCode: 403 });
      }
      const result = beginDepthChargeRackReload(unit);
      if (!result.ok) {
        throw Object.assign(new Error(result.error), { statusCode: 400 });
      }
      save.units[idx] = result.unit;
      return save;
    });
  }

  /**
   * Umpire one-click rearm: full torpedo rooms and/or DC rack for the hull class.
   * Immediate — for live events after physical tube / rack loading.
   */
  rearmUnit(gameId: string, unitId: string): GameSave {
    return this.touch(gameId, (save) => {
      const idx = save.units.findIndex((u) => u.id === unitId);
      if (idx < 0) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      save.units[idx] = rearmUnitWeapons(save.units[idx]!);
      return save;
    });
  }

  /**
   * Live-museum gopher task: umpire free-texts a physical errand and pushes it
   * to one or more vessels (or all v1 player hulls). Field telephone is the
   * verification — never a typed in-app answer. Replacing an active task
   * auto-clears the prior one (logged as superseded) so the AAR history stays
   * complete. Logs an umpire combat-log line so it shows in the Action log /
   * AAR turn scrubber immediately.
   */
  pushGopherTask(
    gameId: string,
    unitIds: string[],
    text: string,
    label?: string,
  ): GameSave {
    const trimmed = text.trim();
    if (!trimmed) {
      throw Object.assign(new Error('Task text required'), { statusCode: 400 });
    }
    return this.touch(gameId, (save) => {
      if (!unitIds.length) {
        throw Object.assign(new Error('No target vessel(s)'), { statusCode: 400 });
      }
      const trimmedLabel = label?.trim() || undefined;
      const newEntries: CombatLogEntry[] = [];
      for (const unitId of unitIds) {
        const unit = save.units.find((u) => u.id === unitId);
        if (!unit) continue;
        if (unit.gopherTask?.status === 'active') {
          newEntries.push(
            logLine({
              kind: 'gopher_task_cleared',
              turnNumber: save.turn.number,
              gameTimeSeconds: save.turn.gameTimeSeconds,
              actor: unit,
              summary: `Gopher task superseded on ${unit.name}: "${unit.gopherTask.text}"`,
            }),
          );
        }
        const task: GopherTask = {
          id: `gt-${nanoid(8)}`,
          text: trimmed,
          label: trimmedLabel,
          status: 'active',
          pushedAt: new Date().toISOString(),
          pushedTurn: save.turn.number,
        };
        unit.gopherTask = task;
        newEntries.push(
          logLine({
            kind: 'gopher_task_pushed',
            turnNumber: save.turn.number,
            gameTimeSeconds: save.turn.gameTimeSeconds,
            actor: unit,
            summary: `Gopher task pushed to ${unit.name}${trimmedLabel ? ` — ${trimmedLabel}` : ''}: "${trimmed}"`,
          }),
        );
      }
      save.combatLog = appendCombatLog(save.combatLog, newEntries);
      return save;
    });
  }

  /**
   * Umpire resolves the active gopher task after phone verification.
   * `outcome` selects the AAR wording (`completed` vs a clear/cancel) —
   * stored status always collapses to the two terminal states in
   * {@link GopherTaskStatus} so player UI logic stays simple.
   */
  resolveGopherTask(
    gameId: string,
    unitId: string,
    outcome: 'completed' | 'cleared' | 'failed',
  ): GameSave {
    return this.touch(gameId, (save) => {
      const unit = save.units.find((u) => u.id === unitId);
      if (!unit) throw Object.assign(new Error('Unit not found'), { statusCode: 404 });
      const task = unit.gopherTask;
      if (!task || task.status !== 'active') {
        throw Object.assign(new Error('No active gopher task'), { statusCode: 400 });
      }
      const status = outcome === 'completed' ? 'completed' : 'cleared';
      unit.gopherTask = {
        ...task,
        status,
        resolvedAt: new Date().toISOString(),
        resolvedTurn: save.turn.number,
      };
      const verb =
        outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed / cancelled' : 'cleared';
      const entry = logLine({
        kind: status === 'completed' ? 'gopher_task_completed' : 'gopher_task_cleared',
        turnNumber: save.turn.number,
        gameTimeSeconds: save.turn.gameTimeSeconds,
        actor: unit,
        summary: `Gopher task ${verb} on ${unit.name}: "${task.text}"`,
      });
      save.combatLog = appendCombatLog(save.combatLog, [entry]);
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
    return this.enqueueTurnMutation(gameId, async () => {
      this.clearTimer(gameId);
      const current = this.requireGame(gameId);
      if (
        current.turn.phase !== 'locked' &&
        current.turn.phase !== 'awaiting_resolution' &&
        current.turn.phase !== 'open'
      ) {
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
      // Persist before swapping the in-memory copy: if the disk write fails,
      // memory stays on the last-durable state instead of racing ahead of
      // disk (previously replace+broadcast happened before the awaited
      // write, so a write failure left memory and disk out of sync and a
      // server restart would silently lose the resolved turn).
      await store.writeSave(resolved);
      this.replace(gameId, resolved);
      this.sse.broadcast(gameId, resolved.stateVersion);
      return resolved;
    });
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
    return this.enqueueTurnMutation(gameId, async () => {
      this.clearTimer(gameId);
      const next = rollbackToTurn(this.requireGame(gameId), turnNumber);
      // Persist before swapping in-memory state (see resolve() above) so a
      // failed write cannot leave memory ahead of the last durable save.
      await store.writeSave(next);
      this.replace(gameId, next);
      this.sse.broadcast(gameId, next.stateVersion);
      return next;
    });
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
      subsystems?: Partial<UnitState['subsystems']> & { sensors?: SubsystemState };
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
        // Umpire depth edits also retarget the standing ordered depth.
        if (patch.position.depth !== undefined) {
          unit.orderedDepth = resolveOrderedDepth(unit.type, patch.position.depth, patch.position.depth);
        }
      }
      if (patch.type !== undefined || patch.class !== undefined) {
        const identity = resolveVesselIdentity({
          type: patch.type ?? unit.type,
          class: patch.class ?? unit.class,
          classId: unit.classId,
        });
        const classChanged = identity.class !== unit.class;
        unit.type = identity.type;
        unit.class = identity.class;
        // Class change → refresh performance defaults (size / max speed / turn / hull dims).
        if (classChanged) {
          unit.maxSpeed = defaultMaxSpeed(identity.class);
          unit.lengthM = defaultLengthM(identity.class);
          unit.beamM = defaultBeamM(identity.class);
          unit.radarSignature = defaultRadarSignature(identity.class);
          unit.turnRate = resolveTurnRate({
            radarSignature: unit.radarSignature,
            class: identity.class,
            type: identity.type,
          });
        }
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
      // Clamp using effective ceiling (submerged subs → ~9 kn); normalizeUnit re-checks.
      const maxSpeed =
        typeof unit.maxSpeed === 'number' && unit.maxSpeed > 0
          ? unit.maxSpeed
          : defaultMaxSpeed(unit.class);
      unit.maxSpeed = maxSpeed;
      unit.speed = clampSpeedToMax(
        unit.speed,
        effectiveMaxSpeed({
          type: unit.type,
          maxSpeed,
          depth: unit.position.depth,
        }),
      );
      // Re-normalize so type rules (surface depth, flight level, dead-in-water) stick.
      save.units[idx] = normalizeUnit(unit);
      return save;
    });
  }

  /**
   * Umpire AAR note for a resolved turn (one per turn; empty string clears it).
   * Only valid for turns already in history (post-resolve) — the live/open
   * turn has no snapshot yet to attach a note to.
   */
  setTurnNote(gameId: string, turnNumber: number, note: string): GameSave {
    return this.touch(gameId, (save) => {
      const idx = save.history.findIndex((h) => h.turnNumber === turnNumber);
      if (idx < 0) {
        throw Object.assign(new Error(`No history snapshot for turn ${turnNumber}`), {
          statusCode: 404,
        });
      }
      const trimmed = note.trim();
      const snap = { ...save.history[idx]! };
      if (trimmed) snap.umpireNote = trimmed;
      else delete snap.umpireNote;
      save.history = [...save.history.slice(0, idx), snap, ...save.history.slice(idx + 1)];
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
