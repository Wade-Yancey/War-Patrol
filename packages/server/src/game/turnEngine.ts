import {
  KNOTS_TO_MPS,
  TURN_DURATION_SECONDS,
  clamp,
  eotTargetSpeed,
  moveAlongHeading,
  normalizeHeading,
  type EotSetting,
  type GameSave,
  type TurnSnapshot,
  type UnitOrders,
  type UnitState,
} from '@war-patrol/shared';

/** Apply simultaneous helm/EOT orders and advance unit kinematics (resolve stub). */
export function resolveTurn(save: GameSave): GameSave {
  const now = new Date().toISOString();
  const resolvedUnits = save.units.map((unit) => applyUnitOrders(unit));

  const snapshot: TurnSnapshot = {
    turnNumber: save.turn.number,
    resolvedAt: now,
    stateVersion: save.stateVersion + 1,
    units: structuredClone(resolvedUnits),
    turn: {
      ...save.turn,
      phase: 'awaiting_resolution',
      timerDeadline: null,
    },
  };

  const next: GameSave = {
    ...save,
    updatedAt: now,
    stateVersion: save.stateVersion + 1,
    units: resolvedUnits,
    turn: {
      number: save.turn.number + 1,
      phase: 'open',
      timerDeadline: null,
      timerSeconds: save.turn.timerSeconds,
    },
    history: [...save.history, snapshot],
  };

  return next;
}

function applyUnitOrders(unit: UnitState): UnitState {
  const orders = unit.orders;
  let heading = unit.heading;
  let eot = unit.eot;
  let speed = unit.speed;

  if (orders.course !== undefined) {
    heading = turnToward(heading, orders.course, unit.turnRate * (TURN_DURATION_SECONDS / 60));
  }

  if (orders.eot !== undefined) {
    eot = orders.eot;
  }

  const target = eotTargetSpeed(eot, unit.maxSpeed);
  // Speed steps toward target (acknowledgment → speed step)
  const step = unit.maxSpeed * 0.35;
  if (speed < target) speed = Math.min(target, speed + step);
  else if (speed > target) speed = Math.max(target, speed - step);

  const distance = Math.abs(speed) * KNOTS_TO_MPS * TURN_DURATION_SECONDS;
  const moveHeading = speed >= 0 ? heading : normalizeHeading(heading + 180);
  const position = distance > 0 ? moveAlongHeading(unit.position, moveHeading, distance) : unit.position;

  return {
    ...unit,
    heading: normalizeHeading(heading),
    eot,
    speed,
    position,
    orders: {},
  };
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

export function mergeOrders(
  existing: UnitOrders,
  patch: { course?: number; eot?: EotSetting },
  stationId: string,
): UnitOrders {
  return {
    ...existing,
    ...(patch.course !== undefined ? { course: normalizeHeading(patch.course) } : {}),
    ...(patch.eot !== undefined ? { eot: patch.eot } : {}),
    updatedAt: new Date().toISOString(),
    updatedByStationId: stationId,
  };
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
    },
    history,
  };
}
