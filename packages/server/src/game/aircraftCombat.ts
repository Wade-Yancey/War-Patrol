/**
 * NPC aircraft attack-run resolve (intercept / strafe / bombing).
 * Standing multi-turn orders: pursue until CPA is in release range, then
 * auto-fire and clear. Far geometry keeps the order for the next resolve.
 * Kept separate from torpedo/DC substeps so destroyer deck-gun work can land
 * beside weaponsResolve without merge thrash on this path.
 */
import {
  aircraftAttackClosestApproach,
  applyHealthDamageResult,
  canOrderAircraftAttack,
  consumeBombLoad,
  formatAircraftAttackModeLabel,
  hasBombLoad,
  healthDamageApplied,
  isAircraftAttackReleaseRange,
  isAircraftAttackTarget,
  isAircraftGunAttackMode,
  makeDetonationEvent,
  normalizeAircraftAttackMode,
  resolveAircraftAttackEffect,
  torpedoHitAudioDelaySec,
  WEAPON_SUBSTEPS,
  type CombatLogEntry,
  type LatLonDepth,
  type UnitState,
  type WeaponDetonationEvent,
} from '@war-patrol/shared';
import { logCasualtyEffects, logLine } from './combatLog.js';

export type AircraftCombatResolveResult = {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
  detonations: WeaponDetonationEvent[];
};

function clearAircraftAttackOrder(unit: UnitState): UnitState {
  const { aircraftAttack: _a, ...rest } = unit.orders;
  return { ...unit, orders: rest };
}

/**
 * Resolve standing `orders.aircraftAttack` after kinematics.
 * Auto-release when CPA ≤ AIRCRAFT_ATTACK_FAR_M (2200 m); otherwise keep
 * pursuing. Bombing consumes one bomb when dropped (not far pursuit).
 * Bombing hit / near-miss / ineffective emit `aircraft_bomb` bridge/hydro cues.
 */
export function resolveAircraftAttacksForTurn(opts: {
  units: UnitState[];
  turnNumber: number;
  turnLengthSeconds: number;
  gameTimeSeconds: number;
  startPositions?: ReadonlyMap<string, LatLonDepth>;
}): AircraftCombatResolveResult {
  let units = opts.units;
  const combatLogEntries: CombatLogEntry[] = [];
  const detonations: WeaponDetonationEvent[] = [];
  const { turnNumber, turnLengthSeconds, gameTimeSeconds, startPositions } = opts;

  const pendingAttacks: Array<{
    attackerId: string;
    mode: ReturnType<typeof normalizeAircraftAttackMode>;
    targetUnitId: string;
  }> = [];
  for (const unit of units) {
    const attack = unit.orders.aircraftAttack;
    if (!attack || !canOrderAircraftAttack(unit)) continue;
    pendingAttacks.push({
      attackerId: unit.id,
      mode: normalizeAircraftAttackMode(attack.mode),
      targetUnitId: String(attack.targetUnitId ?? '').trim(),
    });
  }

  if (!pendingAttacks.length) {
    return { units, combatLogEntries, detonations };
  }

  const unitMap = new Map(units.map((u) => [u.id, u]));
  for (const pending of pendingAttacks) {
    const attacker = unitMap.get(pending.attackerId);
    if (!attacker) continue;
    const target = unitMap.get(pending.targetUnitId);
    const modeLabel = formatAircraftAttackModeLabel(pending.mode);

    if (!target || !isAircraftAttackTarget(target)) {
      const cleared = clearAircraftAttackOrder(attacker);
      units = units.map((u) => (u.id === attacker.id ? cleared : u));
      unitMap.set(attacker.id, cleared);
      combatLogEntries.push(
        logLine({
          kind: 'aircraft_attack',
          turnNumber,
          gameTimeSeconds,
          actor: cleared,
          summary: `${attacker.name} ${modeLabel} aborted — no valid target`,
        }),
      );
      continue;
    }

    // Bombing requires a ready bomb; guns (intercept / strafe) never consume.
    if (pending.mode === 'bombing_run' && !hasBombLoad(attacker)) {
      const cleared = clearAircraftAttackOrder(attacker);
      units = units.map((u) => (u.id === attacker.id ? cleared : u));
      unitMap.set(attacker.id, cleared);
      combatLogEntries.push(
        logLine({
          kind: 'aircraft_attack_miss',
          turnNumber,
          gameTimeSeconds,
          actor: cleared,
          target,
          summary: `${attacker.name} bombing run aborted — no bombs remaining`,
        }),
      );
      continue;
    }

    const acStart = startPositions?.get(attacker.id) ?? attacker.position;
    const acEnd = attacker.position;
    const tgtStart = startPositions?.get(target.id) ?? target.position;
    const tgtEnd = target.position;
    const approach = aircraftAttackClosestApproach({
      aircraftStart: acStart,
      aircraftEnd: acEnd,
      targetStart: tgtStart,
      targetEnd: tgtEnd,
    });

    // Still inbound — keep the standing order, no weapon release this turn.
    if (!isAircraftAttackReleaseRange(approach.missM)) {
      continue;
    }

    combatLogEntries.push(
      logLine({
        kind: 'aircraft_attack',
        turnNumber,
        gameTimeSeconds,
        actor: attacker,
        target,
        summary: `${attacker.name} ${modeLabel} vs ${target.name}`,
      }),
    );

    // In release range: fire once, then clear the standing order.
    let clearedAttacker = clearAircraftAttackOrder(attacker);
    units = units.map((u) => (u.id === attacker.id ? clearedAttacker : u));
    unitMap.set(attacker.id, clearedAttacker);

    const effect = resolveAircraftAttackEffect({
      mode: pending.mode,
      missDistanceM: approach.missM,
      targetDepthM: approach.targetPoint.depth,
      targetType: target.type,
      seed: `${attacker.id}|${target.id}|${pending.mode}|${turnNumber}`,
    });

    // Far miss shouldn't reach here (release gate), but keep bomb-safe.
    const droppedBomb =
      pending.mode === 'bombing_run' && effect.outcome !== 'far_miss';
    if (droppedBomb) {
      clearedAttacker = consumeBombLoad(clearedAttacker);
      units = units.map((u) => (u.id === attacker.id ? clearedAttacker : u));
      unitMap.set(attacker.id, clearedAttacker);
    }

    // Bombing SFX on drop (hit / near-miss / ineffective splash) — not far miss.
    let bombDetonationId: string | undefined;
    if (droppedBomb) {
      bombDetonationId = `abomb-${attacker.id}-${turnNumber}`;
      const audioDelaySec = torpedoHitAudioDelaySec(
        Math.floor(approach.t * (WEAPON_SUBSTEPS - 1)),
        approach.t,
        turnLengthSeconds,
      );
      detonations.push(
        makeDetonationEvent({
          id: bombDetonationId,
          kind: 'aircraft_bomb',
          position: approach.targetPoint,
          turnNumber,
          firerUnitId: attacker.id,
          targetUnitId: target.id,
          audioDelaySec,
        }),
      );
    }

    if (effect.outcome === 'hit' && effect.damage > 0) {
      const { unit: damaged, effects } = applyHealthDamageResult(target, effect.damage);
      const applied = healthDamageApplied(target, damaged);
      units = units.map((u) => (u.id === target.id ? damaged : u));
      unitMap.set(target.id, damaged);
      if (applied > 0) {
        combatLogEntries.push(
          logLine({
            kind: 'aircraft_attack_damage',
            turnNumber,
            gameTimeSeconds,
            actor: clearedAttacker,
            target: damaged,
            damage: applied,
            sourceDetonationId: bombDetonationId,
            summary: `${attacker.name} ${modeLabel} HIT ${target.name} −${applied} HP (CPA ${approach.missM.toFixed(0)} m)`,
          }),
        );
        combatLogEntries.push(
          ...logCasualtyEffects(damaged, effects, {
            turnNumber,
            gameTimeSeconds,
            actor: clearedAttacker,
            sourceDetonationId: bombDetonationId,
          }),
        );
        if (
          (damaged.condition === 'sunk' || damaged.condition === 'sinking') &&
          target.condition === 'afloat'
        ) {
          combatLogEntries.push(
            logLine({
              kind: 'unit_sunk',
              turnNumber,
              gameTimeSeconds,
              target: damaged,
              actor: clearedAttacker,
              sourceDetonationId: bombDetonationId,
              summary: `${damaged.name} SUNK / destroyed`,
            }),
          );
        }
      }
    } else {
      const reason =
        effect.outcome === 'ineffective'
          ? isAircraftGunAttackMode(pending.mode)
            ? 'target too deep for guns'
            : 'target too deep for bombs'
          : effect.outcome === 'far_miss'
            ? 'out of reach this turn'
            : 'near miss';
      combatLogEntries.push(
        logLine({
          kind: 'aircraft_attack_miss',
          turnNumber,
          gameTimeSeconds,
          actor: clearedAttacker,
          target,
          sourceDetonationId: bombDetonationId,
          summary: `${attacker.name} ${modeLabel} vs ${target.name} — ${reason} (CPA ${approach.missM.toFixed(0)} m)`,
        }),
      );
    }
  }

  return { units, combatLogEntries, detonations };
}
