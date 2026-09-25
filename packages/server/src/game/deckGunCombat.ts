/**
 * Destroyer + fleet-sub deck-gun resolve (surface engagement).
 * Kept separate from torpedo/DC substeps and aircraft attack runs so sibling
 * PRs (e.g. aircraft ammo/strafe) can land beside weaponsResolve without
 * merge thrash on this path.
 */
import { nanoid } from 'nanoid';
import {
  DECK_GUN_HIT_AUDIO_DELAY_SEC,
  applyHealthDamageResult,
  buildDeckGunFireBlock,
  canDeckGunFireFromDepth,
  consumeDeckGunShell,
  deckGunMissBand,
  formatCasualtySummary,
  formatDeckGunFireBlockNotice,
  formatTorpedoMissDistance,
  healthDamageApplied,
  isDeckGunHull,
  makeDetonationEvent,
  normalizeDeckGunFireOrder,
  normalizeHeading,
  resolveDeckGunShot,
  type CasualtyEffect,
  type CombatLogEntry,
  type CombatLogKind,
  type DeckGunFireOrder,
  type LatLonDepth,
  type UnitState,
  type WeaponDetonationEvent,
} from '@war-patrol/shared';

export type DeckGunCombatResolveResult = {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
  detonations: WeaponDetonationEvent[];
};

function gunLogLine(opts: {
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
  },
): CombatLogEntry[] {
  return effects.map((effect) =>
    gunLogLine({
      kind: 'subsystem_casualty',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      actor: opts.actor,
      target,
      summary: formatCasualtySummary(target.name, effect),
      casualtyEffect: effect,
    }),
  );
}

/**
 * Resolve pending `orders.fireDeckGun` after kinematics.
 * Consumes one shell on fire; submerged fleet boats block with no ammo spent.
 */
export function resolveDeckGunsForTurn(opts: {
  units: UnitState[];
  turnNumber: number;
  turnLengthSeconds: number;
  gameTimeSeconds: number;
  startPositions?: ReadonlyMap<string, LatLonDepth>;
}): DeckGunCombatResolveResult {
  let units = opts.units.map((u) => ({ ...u }));
  const combatLogEntries: CombatLogEntry[] = [];
  const detonations: WeaponDetonationEvent[] = [];
  const { turnNumber, turnLengthSeconds, gameTimeSeconds, startPositions } = opts;

  const pending: Array<{ firerId: string; fire: DeckGunFireOrder }> = [];

  units = units.map((unit) => {
    let next = unit;
    const fireOrder = unit.orders.fireDeckGun;
    if (
      fireOrder &&
      isDeckGunHull(next) &&
      (next.deckGunLoad ?? 0) > 0 &&
      !next.deckGunAwaitingReload &&
      (next.deckGunReloadTurnsRemaining ?? 0) <= 0
    ) {
      if (!canDeckGunFireFromDepth(next)) {
        next = {
          ...next,
          deckGunFireBlock: buildDeckGunFireBlock(turnNumber, next.position.depth),
        };
        combatLogEntries.push(
          gunLogLine({
            kind: 'deck_gun_fire',
            turnNumber,
            gameTimeSeconds,
            actor: unit,
            summary: `${unit.name} deck-gun order blocked — ${formatDeckGunFireBlockNotice({
              turnNumber,
              reason: 'submerged',
              depthM: next.position.depth,
            })}`,
          }),
        );
      } else {
        const fire = normalizeDeckGunFireOrder(fireOrder);
        next = consumeDeckGunShell(next);
        if (next.deckGunFireBlock) {
          const { deckGunFireBlock: _cleared, ...rest } = next;
          next = rest as UnitState;
        }
        pending.push({ firerId: unit.id, fire });
        const aimLabel = String(Math.round(normalizeHeading(fire.aimHeading))).padStart(3, '0');
        combatLogEntries.push(
          gunLogLine({
            kind: 'deck_gun_fire',
            turnNumber,
            gameTimeSeconds,
            actor: unit,
            summary: `${unit.name} fired deck gun · aim ${aimLabel}° · est ${fire.estimatedRangeNm.toFixed(2)} nm · CRS ${String(Math.round(normalizeHeading(fire.estimatedCourse))).padStart(3, '0')}° · ${fire.estimatedSpeedKn.toFixed(1)} kn`,
          }),
        );
        // Muzzle report on the firer's Controls (cannon WAV).
        detonations.push(
          makeDetonationEvent({
            id: `dgfire-${nanoid(8)}`,
            kind: 'deck_gun_fire',
            position: { ...unit.position, depth: 0 },
            turnNumber,
            firerUnitId: unit.id,
          }),
        );
      }
    }

    if (next.orders.fireDeckGun) {
      const { fireDeckGun: _g, ...rest } = next.orders;
      next = { ...next, orders: rest };
    }
    return next;
  });

  for (const shot of pending) {
    const firer = units.find((u) => u.id === shot.firerId);
    if (!firer) continue;
    const result = resolveDeckGunShot({
      firer,
      fire: shot.fire,
      contacts: units,
      startPositions,
      turnLengthSeconds,
      seed: `${firer.id}|deckgun|${turnNumber}`,
    });
    const fireLabel = String(Math.round(normalizeHeading(result.fireHeading))).padStart(3, '0');
    if (result.outcome === 'hit' && result.hitUnitId && result.damage > 0) {
      const target = units.find((u) => u.id === result.hitUnitId);
      if (target) {
        const { unit: damaged, effects } = applyHealthDamageResult(target, result.damage);
        const applied = healthDamageApplied(target, damaged);
        units = units.map((u) => (u.id === damaged.id ? damaged : u));
        if (applied > 0) {
          const detId = `dghit-${nanoid(8)}`;
          detonations.push(
            makeDetonationEvent({
              id: detId,
              kind: 'deck_gun_hit',
              position: result.impact,
              turnNumber,
              firerUnitId: firer.id,
              targetUnitId: damaged.id,
              audioDelaySec: DECK_GUN_HIT_AUDIO_DELAY_SEC,
            }),
          );
          combatLogEntries.push(
            gunLogLine({
              kind: 'deck_gun_hit',
              turnNumber,
              gameTimeSeconds,
              actor: firer,
              target: damaged,
              damage: applied,
              summary: `${firer.name} deck gun HIT ${target.name} −${applied} HP (FIRE ${fireLabel}° · miss ${result.missDistanceM.toFixed(0)} m)`,
              sourceDetonationId: detId,
            }),
          );
          combatLogEntries.push(
            ...logCasualtyEffects(damaged, effects, {
              turnNumber,
              gameTimeSeconds,
              actor: firer,
            }),
          );
          if (damaged.condition === 'sunk') {
            combatLogEntries.push(
              gunLogLine({
                kind: 'unit_sunk',
                turnNumber,
                gameTimeSeconds,
                target: damaged,
                actor: firer,
                summary: `${damaged.name} SUNK / destroyed`,
              }),
            );
          }
        }
      }
    } else {
      const cpaLabel =
        result.closestApproachUnitName && Number.isFinite(result.missDistanceM)
          ? ` — CPA ${result.closestApproachUnitName} ${formatTorpedoMissDistance(result.missDistanceM)} (${deckGunMissBand(result.missDistanceM)} miss)`
          : result.outcome === 'out_of_range'
            ? ' — no range solution'
            : ' — no surface target in gate';
      combatLogEntries.push(
        gunLogLine({
          kind: 'deck_gun_miss',
          turnNumber,
          gameTimeSeconds,
          actor: firer,
          target: result.closestApproachUnitId
            ? units.find((u) => u.id === result.closestApproachUnitId)
            : undefined,
          summary: `${firer.name} deck gun MISS (FIRE ${fireLabel}°)${cpaLabel}`,
        }),
      );
    }
  }

  return { units, combatLogEntries, detonations };
}
