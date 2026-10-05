import {
  PERISCOPE_DEPTH_M,
  advanceSinkingUnits,
  applyAircraftStandingOrders,
  applyVesselStandingOrders,
  applyCrushDepthImplosions,
  applyUnitKinematics,
  clampDepthChargeSetting,
  clampSubmarineDepth,
  depthChargeCountFromOrder,
  depthChargePatternForCount,
  normalizeAircraftAttackMode,
  normalizeVesselStandingMode,
  normalizeDeckGunFireOrder,
  normalizeHeading,
  clampTorpedoSpreadCount,
  clampTorpedoSpreadDeg,
  normalizeTorpedoRoomId,
  resolveTurnLengthSeconds,
  type AircraftAttackOrder,
  type VesselStandingOrder,
  type DeckGunFireOrder,
  type DepthChargeDropOrder,
  type EotSetting,
  type GameSave,
  type TorpedoFireOrder,
  type TurnSnapshot,
  type UnitOrders,
  type UnitState,
} from '@war-patrol/shared';
import { buildPeriscopeContacts } from './periscope.js';
import { resolveWeaponsForTurn, appendCombatLog } from './weaponsResolve.js';

/**
 * Scenario-start / start-of-turn-1 state.
 * Not an end-of-resolve history entry — those are labeled with the turn they finished.
 */
export function captureOpeningSnapshot(save: GameSave): TurnSnapshot {
  const gameTimeSeconds = save.turn.gameTimeSeconds ?? 0;
  return {
    turnNumber: 1,
    resolvedAt: save.createdAt,
    stateVersion: save.stateVersion,
    units: structuredClone(save.units),
    turn: {
      ...save.turn,
      number: 1,
      phase: 'open',
      timerDeadline: null,
      gameTimeSeconds,
    },
    gameTimeSeconds,
    torpedoes: structuredClone(save.torpedoes ?? []),
    depthCharges: structuredClone(save.depthCharges ?? []),
  };
}

/** Apply simultaneous helm/EOT/depth/weapons orders and advance kinematics + tracks. */
export function resolveTurn(save: GameSave): GameSave {
  // Keep the scenario start. History appended below is the post-resolve state.
  const openingSnapshot =
    save.openingSnapshot ??
    (save.turn.number === 1 && (save.history?.length ?? 0) === 0
      ? captureOpeningSnapshot(save)
      : undefined);

  const now = new Date().toISOString();
  const turnLength = resolveTurnLengthSeconds(save.turnLengthSeconds);
  const gameTimeSeconds = (save.turn.gameTimeSeconds ?? 0) + turnLength;
  const resolveTurnNumber = save.turn.number;

  // Snapshot pre-move positions so depth charges can trail along the move.
  const startPositions = new Map(
    save.units.map((u) => [u.id, { ...u.position } as const]),
  );

  // Tick prior-turn sinking countdowns before kinematics / weapons so newly
  // lethal hulls (set later this resolve) keep a full VESSEL_SINKING_TURNS linger.
  const afterSinking = advanceSinkingUnits(save.units);

  // Standing aircraft attack / loiter + vessel intercept / attack / evade inject
  // course (+ preferred EOT) before kinematics.
  const afterAircraft = applyAircraftStandingOrders(afterSinking);
  const standingReady = applyVesselStandingOrders(afterAircraft, turnLength);

  // Kinematics first (orders still present for weapon launch snapshot).
  const movedUnits = standingReady.map((unit) => applyUnitOrders(unit, turnLength, false));

  // Periscope auto-lower when too deep; plot stamp accrue/reset (no frozen bonus).
  const stampedUnits = applyPeriscopePlotStamps(movedUnits, save);

  // Past crush depth: per-turn implosion RNG (strictly deeper than crush).
  const crush = applyCrushDepthImplosions(stampedUnits, {
    turnNumber: resolveTurnNumber,
    gameTimeSeconds,
    nowIso: now,
  });

  const weapons = resolveWeaponsForTurn(
    crush.units,
    save.torpedoes ?? [],
    save.depthCharges ?? [],
    save.recentDetonations ?? [],
    resolveTurnNumber,
    turnLength,
    gameTimeSeconds,
    startPositions,
  );

  // Clear helm/EOT/depth / one-shot weapon fields after resolve. Standing aircraft
  // attack and vessel standing orders persist until cancel / target gone (like loiter).
  const resolvedUnits = weapons.units.map((u) => {
    const attack = u.orders.aircraftAttack;
    const vessel = u.orders.vesselStanding;
    const next: UnitOrders = {};
    if (attack) {
      next.aircraftAttack = { mode: attack.mode, targetUnitId: attack.targetUnitId };
    }
    if (vessel) {
      next.vesselStanding = {
        mode: vessel.mode,
        ...(vessel.targetUnitId ? { targetUnitId: vessel.targetUnitId } : {}),
        ...(typeof vessel.evadeBaseCourse === 'number'
          ? { evadeBaseCourse: vessel.evadeBaseCourse }
          : {}),
        ...(vessel.evadeLeg === 0 || vessel.evadeLeg === 1
          ? { evadeLeg: vessel.evadeLeg }
          : {}),
      };
    }
    return {
      ...u,
      orders: next,
    };
  });

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
    torpedoes: structuredClone(weapons.torpedoes),
    depthCharges: structuredClone(weapons.depthCharges),
  };

  const next: GameSave = {
    ...save,
    openingSnapshot,
    updatedAt: now,
    stateVersion: save.stateVersion + 1,
    turnLengthSeconds: turnLength,
    units: resolvedUnits,
    torpedoes: weapons.torpedoes,
    depthCharges: weapons.depthCharges,
    recentDetonations: weapons.recentDetonations,
    combatLog: appendCombatLog(save.combatLog, [
      ...crush.combatLogEntries,
      ...weapons.combatLogEntries,
    ]),
    turn: nextTurnState,
    history: [...save.history, snapshot],
  };

  return next;
}

/**
 * After depth step: force mast down when too deep; reset plot stamp on lower;
 * accrue stamp turns while scope stays up with at least one visual contact.
 * v1 does not apply stamp as a hit/damage bonus (geometry-first only).
 */
function applyPeriscopePlotStamps(units: UnitState[], save: GameSave): UnitState[] {
  const probeSave: GameSave = { ...save, units };
  return units.map((unit) => {
    if (unit.type !== 'Submarine') {
      return { ...unit, periscopeRaised: false, periscopeExposure: 0, plotStampTurns: 0 };
    }
    if (unit.position.depth > PERISCOPE_DEPTH_M) {
      return { ...unit, periscopeRaised: false, periscopeExposure: 0, plotStampTurns: 0 };
    }
    if (!unit.periscopeRaised) {
      return { ...unit, periscopeExposure: 0, plotStampTurns: 0 };
    }
    const pic = buildPeriscopeContacts(unit, probeSave);
    if (pic.operational && pic.contacts.length > 0) {
      return { ...unit, plotStampTurns: (unit.plotStampTurns ?? 0) + 1 };
    }
    return unit;
  });
}

/**
 * Apply helm/EOT/depth kinematics.
 * When `clearOrders` is false, weapon order fields are preserved for launch this resolve.
 * Shared with umpire GT move prediction ({@link applyUnitKinematics} /
 * {@link predictUnitMovePath} — prediction applies aircraft + vessel standing
 * orders first).
 */
function applyUnitOrders(
  unit: UnitState,
  turnLengthSeconds: number,
  clearOrders = true,
): UnitState {
  return applyUnitKinematics(unit, turnLengthSeconds, clearOrders);
}

export function clearInProgressOrders(units: UnitState[]): UnitState[] {
  return units.map((u) => ({ ...u, orders: {} as UnitOrders }));
}

export type OrdersPatch = {
  course?: number;
  eot?: EotSetting;
  depth?: number;
  /** Ballast blow — bypasses dive-plane jam for surface orders. */
  emergencyBlow?: boolean;
  fireTorpedo?: TorpedoFireOrder | null;
  dropDepthCharges?: DepthChargeDropOrder | null;
  fireDeckGun?: DeckGunFireOrder | null;
  aircraftAttack?: AircraftAttackOrder | null;
  vesselStanding?: VesselStandingOrder | null;
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
  if (patch.depth !== undefined) {
    if (patch.emergencyBlow) next.emergencyBlow = true;
    else delete next.emergencyBlow;
  }
  if (patch.fireTorpedo === null) {
    delete next.fireTorpedo;
  } else if (patch.fireTorpedo) {
    next.fireTorpedo = {
      room: normalizeTorpedoRoomId(patch.fireTorpedo.room),
      aimHeading: normalizeHeading(patch.fireTorpedo.aimHeading),
      estimatedCourse: normalizeHeading(patch.fireTorpedo.estimatedCourse),
      estimatedSpeedKn: Math.max(0, Number(patch.fireTorpedo.estimatedSpeedKn) || 0),
      estimatedRangeNm: Math.max(0, Number(patch.fireTorpedo.estimatedRangeNm) || 0),
      estimatedLengthM: Math.max(0, Number(patch.fireTorpedo.estimatedLengthM) || 0),
      spreadCount: clampTorpedoSpreadCount(patch.fireTorpedo.spreadCount),
      spreadDeg: clampTorpedoSpreadDeg(patch.fireTorpedo.spreadDeg),
    };
  }
  if (patch.dropDepthCharges === null) {
    delete next.dropDepthCharges;
  } else if (patch.dropDepthCharges) {
    const count = depthChargeCountFromOrder(patch.dropDepthCharges);
    next.dropDepthCharges = {
      count,
      pattern: depthChargePatternForCount(count),
      depthSettingM: clampDepthChargeSetting(patch.dropDepthCharges.depthSettingM),
    };
  }
  if (patch.fireDeckGun === null) {
    delete next.fireDeckGun;
  } else if (patch.fireDeckGun) {
    next.fireDeckGun = normalizeDeckGunFireOrder(patch.fireDeckGun);
  }
  if (patch.aircraftAttack === null) {
    delete next.aircraftAttack;
  } else if (patch.aircraftAttack) {
    next.aircraftAttack = {
      mode: normalizeAircraftAttackMode(patch.aircraftAttack.mode),
      targetUnitId: String(patch.aircraftAttack.targetUnitId ?? '').trim(),
    };
  }
  if (patch.vesselStanding === null) {
    delete next.vesselStanding;
  } else if (patch.vesselStanding) {
    const mode = normalizeVesselStandingMode(patch.vesselStanding.mode);
    const targetUnitId = String(patch.vesselStanding.targetUnitId ?? '').trim() || undefined;
    const standing: VesselStandingOrder = { mode };
    if (targetUnitId) standing.targetUnitId = targetUnitId;
    if (mode === 'evade') {
      if (
        typeof patch.vesselStanding.evadeBaseCourse === 'number' &&
        Number.isFinite(patch.vesselStanding.evadeBaseCourse)
      ) {
        standing.evadeBaseCourse = normalizeHeading(patch.vesselStanding.evadeBaseCourse);
      }
      standing.evadeLeg = patch.vesselStanding.evadeLeg === 1 ? 1 : 0;
    }
    next.vesselStanding = standing;
  }
  return next;
}

export function setTimerDeadline(seconds: number, from = Date.now()): string {
  return new Date(from + seconds * 1000).toISOString();
}

function restoreScenarioStart(save: GameSave, opening: TurnSnapshot): GameSave {
  const units = clearInProgressOrders(structuredClone(opening.units));
  const gameTimeSeconds = opening.gameTimeSeconds ?? opening.turn.gameTimeSeconds ?? 0;
  return {
    ...save,
    updatedAt: new Date().toISOString(),
    stateVersion: save.stateVersion + 1,
    units,
    torpedoes: structuredClone(opening.torpedoes ?? []),
    depthCharges: structuredClone(opening.depthCharges ?? []),
    recentDetonations: [],
    combatLog: [],
    turn: {
      number: 1,
      phase: 'open',
      timerDeadline: null,
      timerSeconds: save.turn.timerSeconds,
      gameTimeSeconds,
    },
    history: [],
  };
}

export function rollbackToTurn(save: GameSave, turnNumber: number): GameSave {
  // history[0] is the end of turn 1. Rolling back to turn 1 must restore the
  // scenario start, not that post-resolve snapshot (which reopens turn 2 unchanged).
  if (turnNumber === 1 && save.openingSnapshot) {
    return restoreScenarioStart(save, save.openingSnapshot);
  }

  const snap = save.history.find((h) => h.turnNumber === turnNumber);
  if (!snap) {
    throw new Error(`No history snapshot for turn ${turnNumber}`);
  }
  // Restore units from snapshot (state at end of that turn's resolve), reopen as next turn
  const units = clearInProgressOrders(structuredClone(snap.units));
  const history = save.history.filter((h) => h.turnNumber < turnNumber);
  const gameTimeSeconds =
    snap.gameTimeSeconds ?? snap.turn.gameTimeSeconds ?? save.turn.gameTimeSeconds ?? 0;
  // Match T1 semantics: drop combat cues logged after the restored turn so
  // bridge/umpire views do not keep post-rollback detonations or CRT lines.
  // (T1 restore clears both entirely — equivalent to retaining nothing pre-resolve.)
  const recentDetonations = (save.recentDetonations ?? []).filter(
    (d) => d.turnNumber <= turnNumber,
  );
  const combatLog = (save.combatLog ?? []).filter((e) => e.turnNumber <= turnNumber);
  return {
    ...save,
    updatedAt: new Date().toISOString(),
    stateVersion: save.stateVersion + 1,
    units,
    // Prefer weapon tracks snapshotted with the turn (AAR / post-persist saves).
    torpedoes: structuredClone(snap.torpedoes ?? []),
    depthCharges: structuredClone(snap.depthCharges ?? []),
    recentDetonations,
    combatLog,
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
