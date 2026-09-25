/**
 * NPC aircraft attack-run resolve (intercept / strafe / bombing).
 * Kept separate from torpedo/DC substeps so destroyer deck-gun work can land
 * beside weaponsResolve without merge thrash on this path.
 */
import { nanoid } from 'nanoid';
import {
  aircraftAttackClosestApproach,
  applyHealthDamageResult,
  canOrderAircraftAttack,
  consumeBombLoad,
  formatAircraftAttackModeLabel,
  formatCasualtySummary,
  hasBombLoad,
  healthDamageApplied,
  isAircraftAttackTarget,
  isAircraftGunAttackMode,
  makeDetonationEvent,
  normalizeAircraftAttackMode,
  resolveAircraftAttackEffect,
  torpedoHitAudioDelaySec,
  WEAPON_SUBSTEPS,
  type CasualtyEffect,
  type CombatLogEntry,
  type CombatLogKind,
  type LatLonDepth,
  type UnitState,
  type WeaponDetonationEvent,
} from '@war-patrol/shared';

export type AircraftCombatResolveResult = {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
  detonations: WeaponDetonationEvent[];
};

function airLogLine(opts: {
  kind: CombatLogKind;
  turnNumber: number;
  gameTimeSeconds: number;
  summary: string;
  actor?: UnitState;
  target?: UnitState;
  damage?: number;
  sourceDetonationId?: string;
  casualtyEffect?: CasualtyEffect;
}): CombatLogEntry {
  return {
    id: `cl-${nanoid(8)}`,
    kind: opts.kind,
    turnNumber: opts.turnNumber,
    gameTimeSeconds: opts.gameTimeSeconds,
    at: new Date().toISOString(),
    summary: opts.summary,
    actorUnitId: opts.actor?.id,
    actorName: opts.actor?.name,
    targetUnitId: opts.target?.id,
    targetName: opts.target?.name,
    damage: opts.damage,
    ...(opts.sourceDetonationId ? { sourceDetonationId: opts.sourceDetonationId } : {}),
    ...(opts.casualtyEffect ? { casualtyEffect: opts.casualtyEffect } : {}),
  };
}

function logCasualtyEffects(
  target: UnitState,
  effects: CasualtyEffect[],
  opts: {
    turnNumber: number;
    gameTimeSeconds: number;
    actor?: UnitState;
    sourceDetonationId?: string;
  },
): CombatLogEntry[] {
  return effects.map((effect) =>
    airLogLine({
      kind: 'subsystem_casualty',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      actor: opts.actor,
      target,
      summary: formatCasualtySummary(target.name, effect),
      sourceDetonationId: opts.sourceDetonationId,
      casualtyEffect: effect,
    }),
  );
}

/**
 * Resolve pending `orders.aircraftAttack` after kinematics.
 * Bombing consumes one bomb when dropped (not far-miss out of reach).
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
    combatLogEntries.push(
      airLogLine({
        kind: 'aircraft_attack',
        turnNumber,
        gameTimeSeconds,
        actor: attacker,
        target: target && isAircraftAttackTarget(target) ? target : undefined,
        summary: `${attacker.name} ${modeLabel} vs ${
          (target?.name ?? pending.targetUnitId) || 'unknown'
        }`,
      }),
    );

    // Clear attack order whether or not the target is valid.
    let clearedAttacker: UnitState = {
      ...attacker,
      orders: (() => {
        const { aircraftAttack: _a, ...rest } = attacker.orders;
        return rest;
      })(),
    };
    units = units.map((u) => (u.id === attacker.id ? clearedAttacker : u));
    unitMap.set(attacker.id, clearedAttacker);

    if (!target || !isAircraftAttackTarget(target)) {
      combatLogEntries.push(
        airLogLine({
          kind: 'aircraft_attack_miss',
          turnNumber,
          gameTimeSeconds,
          actor: clearedAttacker,
          summary: `${attacker.name} ${modeLabel} aborted — no valid target`,
        }),
      );
      continue;
    }

    // Bombing requires a ready bomb; guns (intercept / strafe) never consume.
    if (pending.mode === 'bombing_run' && !hasBombLoad(clearedAttacker)) {
      combatLogEntries.push(
        airLogLine({
          kind: 'aircraft_attack_miss',
          turnNumber,
          gameTimeSeconds,
          actor: clearedAttacker,
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
    const effect = resolveAircraftAttackEffect({
      mode: pending.mode,
      missDistanceM: approach.missM,
      targetDepthM: approach.targetPoint.depth,
      targetType: target.type,
      seed: `${attacker.id}|${target.id}|${pending.mode}|${turnNumber}`,
    });

    // Far miss = out of reach — bomb stays on the rack. Any closer proceeds.
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
          airLogLine({
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
        if (damaged.condition === 'sunk') {
          combatLogEntries.push(
            airLogLine({
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
        airLogLine({
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
