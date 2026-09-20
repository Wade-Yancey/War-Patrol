import {
  KNOTS_TO_MPS,
  canMakeWay,
  clamp,
  clampDepthChargeSetting,
  clampSpeedToMax,
  clampSubmarineDepth,
  effectiveMaxSpeed,
  moveAlongHeading,
  normalizeDepthChargePattern,
  normalizeHeading,
  normalizePositionForType,
  clampTorpedoSpreadCount,
  clampTorpedoSpreadDeg,
  resolveOrderedDepth,
  resolveSpeedStepFraction,
  resolveTurnLengthSeconds,
  stepSpeedTowardTarget,
  targetSpeedForUnit,
  type DepthChargeDropOrder,
  type EotSetting,
  type GameSave,
  type TorpedoFireOrder,
  type TurnSnapshot,
  type UnitOrders,
  type UnitState,
} from '@war-patrol/shared';
import { resolveWeaponsForTurn, appendCombatLog } from './weaponsResolve.js';

/** Apply simultaneous helm/EOT/depth/weapons orders and advance kinematics + tracks. */
export function resolveTurn(save: GameSave): GameSave {
  const now = new Date().toISOString();
  const turnLength = resolveTurnLengthSeconds(save.turnLengthSeconds);
  const gameTimeSeconds = (save.turn.gameTimeSeconds ?? 0) + turnLength;
  const resolveTurnNumber = save.turn.number;

  // Snapshot pre-move positions so depth charges can trail along the move.
  const startPositions = new Map(
    save.units.map((u) => [u.id, { ...u.position } as const]),
  );

  // Kinematics first (orders still present for weapon launch snapshot).
  const movedUnits = save.units.map((unit) => applyUnitOrders(unit, turnLength, false));

  const weapons = resolveWeaponsForTurn(
    movedUnits,
    save.torpedoes ?? [],
    save.depthCharges ?? [],
    save.recentDetonations ?? [],
    resolveTurnNumber,
    turnLength,
    gameTimeSeconds,
    startPositions,
  );

  // Clear remaining helm/EOT/depth orders after weapons consumed fire/drop fields.
  const resolvedUnits = weapons.units.map((u) => ({ ...u, orders: {} as UnitOrders }));

  const nextTurnState = {
    number: save.turn.number + 1,
    phase: 'open' as const,
    timerDeadline: null,
    timerSeconds: save.turn.timerSeconds,
    gameTimeSeconds,
  };

  const snapshot: TurnSnapshot = {
    turnNumber: save.turn.number,
    resolvedAt: now,
    stateVersion: save.stateVersion + 1,
    units: structuredClone(resolvedUnits),
    turn: {
      ...save.turn,
      phase: 'awaiting_resolution',
      timerDeadline: null,
      gameTimeSeconds,
    },
    gameTimeSeconds,
  };

  const next: GameSave = {
    ...save,
    updatedAt: now,
    stateVersion: save.stateVersion + 1,
    turnLengthSeconds: turnLength,
    units: resolvedUnits,
    torpedoes: weapons.torpedoes,
    depthCharges: weapons.depthCharges,
    recentDetonations: weapons.recentDetonations,
    combatLog: appendCombatLog(save.combatLog, weapons.combatLogEntries),
    turn: nextTurnState,
    history: [...save.history, snapshot],
  };

  return next;
}

/**
 * Apply helm/EOT/depth kinematics.
 * When `clearOrders` is false, weapon order fields are preserved for launch this resolve.
 */
function applyUnitOrders(
  unit: UnitState,
  turnLengthSeconds: number,
  clearOrders = true,
): UnitState {
  // Sunk / destroyed or dead propulsion: no way — clear motion, ignore orders kinematics.
  if (!canMakeWay(unit)) {
    return {
      ...unit,
      speed: 0,
      eot: 'stop',
      orders: clearOrders ? {} : preserveWeaponOrders(unit.orders),
    };
  }

  const orders = unit.orders;
  let orderedCourse =
    typeof unit.orderedCourse === 'number' ? unit.orderedCourse : unit.heading;
  let orderedDepth = resolveOrderedDepth(unit.type, unit.position.depth, unit.orderedDepth);
  let heading = unit.heading;
  let eot = unit.eot;
  let speed = unit.speed;
  let position = { ...unit.position };

  // Helm order updates the persistent steering course immediately for this resolve.
  if (orders.course !== undefined) {
    orderedCourse = normalizeHeading(orders.course);
  }

  // Depth order updates the standing set-point; actual depth snaps this resolve (v1 stub).
  if (orders.depth !== undefined && unit.type === 'Submarine') {
    orderedDepth = clampSubmarineDepth(orders.depth);
  }
  if (unit.type === 'Submarine') {
    position = { ...position, depth: orderedDepth };
  } else {
    orderedDepth = 0;
    position = normalizePositionForType(unit.type, position);
  }

  // Turn toward ordered course (size-based turnRate deg/min × in-game minutes).
  const maxDelta = unit.turnRate * (turnLengthSeconds / 60);
  heading = turnToward(heading, orderedCourse, maxDelta);

  if (orders.eot !== undefined) {
    eot = orders.eot;
  }

  // Submarines deeper than surface band use submerged max (~9 kn), not hull maxSpeed.
  // Use post-dive depth so a dive+move in the same resolve uses submerged ceiling.
  const speedCeiling = effectiveMaxSpeed({
    type: unit.type,
    maxSpeed: unit.maxSpeed,
    depth: position.depth,
  });
  // Ships/subs: signed EOT target. Aircraft: loiter/cruise/full (never reverse).
  const target = targetSpeedForUnit(unit.type, eot, speedCeiling);
  // Speed steps toward target (class-scaled fraction of effective max per resolve).
  // Momentum: cannot cross through zero in one resolve (ships/subs reverse via stop).
  const step =
    speedCeiling * resolveSpeedStepFraction({ class: unit.class, type: unit.type });
  speed = stepSpeedTowardTarget(speed, target, step);
  if (unit.type === 'Aircraft') {
    // Aircraft never make sternway; clamp any legacy negative speed to ≥ 0.
    speed = Math.max(0, speed);
  }
  speed = clampSpeedToMax(speed, speedCeiling);

  const distance = Math.abs(speed) * KNOTS_TO_MPS * turnLengthSeconds;
  const moveHeading = speed >= 0 ? heading : normalizeHeading(heading + 180);
  position = distance > 0 ? moveAlongHeading(position, moveHeading, distance) : position;

  const nextOrders = clearOrders ? {} : preserveWeaponOrders(orders);

  return {
    ...unit,
    heading: normalizeHeading(heading),
    orderedCourse: normalizeHeading(orderedCourse),
    orderedDepth,
    eot,
    speed,
    position,
    orders: nextOrders,
  };
}

function preserveWeaponOrders(orders: UnitOrders): UnitOrders {
  const next: UnitOrders = {};
  if (orders.fireTorpedo) next.fireTorpedo = { ...orders.fireTorpedo };
  if (orders.dropDepthCharges) next.dropDepthCharges = { ...orders.dropDepthCharges };
  return next;
}

function turnToward(current: number, desired: number, maxDelta: number): number {
  const cur = normalizeHeading(current);
  const des = normalizeHeading(desired);
  let delta = des - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const applied = clamp(delta, -maxDelta, maxDelta);
  return normalizeHeading(cur + applied);
}

export function clearInProgressOrders(units: UnitState[]): UnitState[] {
  return units.map((u) => ({ ...u, orders: {} as UnitOrders }));
}

export type OrdersPatch = {
  course?: number;
  eot?: EotSetting;
  depth?: number;
  fireTorpedo?: TorpedoFireOrder | null;
  dropDepthCharges?: DepthChargeDropOrder | null;
};

export function mergeOrders(
  existing: UnitOrders,
  patch: OrdersPatch,
  stationId: string,
): UnitOrders {
  const next: UnitOrders = {
    ...existing,
    ...(patch.course !== undefined ? { course: normalizeHeading(patch.course) } : {}),
    ...(patch.eot !== undefined ? { eot: patch.eot } : {}),
    ...(patch.depth !== undefined ? { depth: clampSubmarineDepth(patch.depth) } : {}),
    updatedAt: new Date().toISOString(),
    updatedByStationId: stationId,
  };
  if (patch.fireTorpedo === null) {
    delete next.fireTorpedo;
  } else if (patch.fireTorpedo) {
    next.fireTorpedo = {
      aimHeading: normalizeHeading(patch.fireTorpedo.aimHeading),
      estimatedLengthM: Math.max(0, Number(patch.fireTorpedo.estimatedLengthM) || 0),
      estimatedSpeedKn: Math.max(0, Number(patch.fireTorpedo.estimatedSpeedKn) || 0),
      spreadCount: clampTorpedoSpreadCount(patch.fireTorpedo.spreadCount),
      spreadDeg: clampTorpedoSpreadDeg(patch.fireTorpedo.spreadDeg),
    };
  }
  if (patch.dropDepthCharges === null) {
    delete next.dropDepthCharges;
  } else if (patch.dropDepthCharges) {
    next.dropDepthCharges = {
      pattern: normalizeDepthChargePattern(patch.dropDepthCharges.pattern),
      depthSettingM: clampDepthChargeSetting(patch.dropDepthCharges.depthSettingM),
    };
  }
  return next;
}

export function setTimerDeadline(seconds: number, from = Date.now()): string {
  return new Date(from + seconds * 1000).toISOString();
}

export function rollbackToTurn(save: GameSave, turnNumber: number): GameSave {
  const snap = save.history.find((h) => h.turnNumber === turnNumber);
  if (!snap) {
    throw new Error(`No history snapshot for turn ${turnNumber}`);
  }
  // Restore units from snapshot (state at end of that turn's resolve), reopen as next turn
  const units = clearInProgressOrders(structuredClone(snap.units));
  const history = save.history.filter((h) => h.turnNumber < turnNumber);
  const gameTimeSeconds =
    snap.gameTimeSeconds ?? snap.turn.gameTimeSeconds ?? save.turn.gameTimeSeconds ?? 0;
  return {
    ...save,
    updatedAt: new Date().toISOString(),
    stateVersion: save.stateVersion + 1,
    units,
    turn: {
      number: turnNumber + 1,
      phase: 'open',
      timerDeadline: null,
      timerSeconds: save.turn.timerSeconds,
      gameTimeSeconds,
    },
    history,
  };
}
