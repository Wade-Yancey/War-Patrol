/**
 * Destroyer + fleet-sub deck-gun resolve (surface engagement).
 * Kept separate from torpedo/DC substeps and aircraft attack runs so sibling
 * PRs (e.g. aircraft ammo/strafe) can land beside weaponsResolve without
 * merge thrash on this path.
 */
import { nanoid } from 'nanoid';
import {
  DECK_GUN_FIRE_STAGGER_SEC,
  DECK_GUN_HIT_AUDIO_DELAY_SEC,
  applyHealthDamageResult,
  buildDeckGunFireBlock,
  canDeckGunFireFromDepth,
  clampDeckGunShotCount,
  consumeDeckGunShells,
  deckGunMissBand,
  deckGunSalvoFireFractions,
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

type PendingSalvo = {
  firerId: string;
  fire: DeckGunFireOrder;
  shotCount: number;
};

/**
 * Resolve pending `orders.fireDeckGun` after kinematics.
 * Consumes one shell per round in the salvo; submerged fleet boats block
 * with no ammo spent. Multi-shot salvos space rounds across the turn
 * timeline (per-shot hit checks) and emit one staggered muzzle report each.
 * Hit/miss splash detonations carry aim heading for umpire GT map lines.
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

  const pending: PendingSalvo[] = [];

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
        const shotCount = clampDeckGunShotCount(fire.shotCount, next);
        if (shotCount > 0) {
          next = consumeDeckGunShells(next, shotCount);
          if (next.deckGunFireBlock) {
            const { deckGunFireBlock: _cleared, ...rest } = next;
            next = rest as UnitState;
          }
          pending.push({ firerId: unit.id, fire: { ...fire, shotCount }, shotCount });
          const aimLabel = String(Math.round(normalizeHeading(fire.aimHeading))).padStart(3, '0');
          const salvoLabel = shotCount > 1 ? ` ×${shotCount}` : '';
          combatLogEntries.push(
            gunLogLine({
              kind: 'deck_gun_fire',
              turnNumber,
              gameTimeSeconds,
              actor: unit,
              summary: `${unit.name} fired deck gun${salvoLabel} · aim ${aimLabel}° · est ${fire.estimatedRangeNm.toFixed(2)} nm · CRS ${String(Math.round(normalizeHeading(fire.estimatedCourse))).padStart(3, '0')}° · ${fire.estimatedSpeedKn.toFixed(1)} kn`,
            }),
          );
          // One muzzle report per round (cannon WAV), staggered for counting.
          for (let i = 0; i < shotCount; i++) {
            detonations.push(
              makeDetonationEvent({
                id: `dgfire-${nanoid(8)}`,
                kind: 'deck_gun_fire',
                position: { ...unit.position, depth: 0 },
                turnNumber,
                firerUnitId: unit.id,
                aimHeading: fire.aimHeading,
                ...(i > 0 ? { audioDelaySec: i * DECK_GUN_FIRE_STAGGER_SEC } : {}),
              }),
            );
          }
        }
      }
    }

    if (next.orders.fireDeckGun) {
      const { fireDeckGun: _g, ...rest } = next.orders;
      next = { ...next, orders: rest };
    }
    return next;
  });

  for (const salvo of pending) {
    const firer = units.find((u) => u.id === salvo.firerId);
    if (!firer) continue;
    const fractions = deckGunSalvoFireFractions(salvo.shotCount);
    for (let i = 0; i < salvo.shotCount; i++) {
      const fireFrac = fractions[i] ?? 0;
      const result = resolveDeckGunShot({
        firer,
        fire: salvo.fire,
        contacts: units,
        startPositions,
        turnLengthSeconds,
        seed: `${firer.id}|deckgun|${turnNumber}|${i}`,
        fireTurnFraction: fireFrac,
      });
      const fireLabel = String(Math.round(normalizeHeading(result.fireHeading))).padStart(3, '0');
      const aimLabel = String(Math.round(normalizeHeading(salvo.fire.aimHeading))).padStart(3, '0');
      const roundTag = salvo.shotCount > 1 ? ` r${i + 1}/${salvo.shotCount}` : '';
      const fireAudioDelay = i * DECK_GUN_FIRE_STAGGER_SEC;
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
                aimHeading: result.fireHeading,
                audioDelaySec: fireAudioDelay + DECK_GUN_HIT_AUDIO_DELAY_SEC,
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
                summary: `${firer.name} deck gun HIT${roundTag} ${target.name} −${applied} HP (aim ${aimLabel}° · FIRE ${fireLabel}° · miss ${result.missDistanceM.toFixed(0)} m)`,
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
        const detId = `dgmiss-${nanoid(8)}`;
        detonations.push(
          makeDetonationEvent({
            id: detId,
            kind: 'deck_gun_miss',
            position: result.impact,
            turnNumber,
            firerUnitId: firer.id,
            ...(result.closestApproachUnitId
              ? { targetUnitId: result.closestApproachUnitId }
              : {}),
            aimHeading: result.fireHeading,
          }),
        );
        combatLogEntries.push(
          gunLogLine({
            kind: 'deck_gun_miss',
            turnNumber,
            gameTimeSeconds,
            actor: firer,
            target: result.closestApproachUnitId
              ? units.find((u) => u.id === result.closestApproachUnitId)
              : undefined,
            summary: `${firer.name} deck gun MISS${roundTag} (aim ${aimLabel}° · FIRE ${fireLabel}°)${cpaLabel}`,
            sourceDetonationId: detId,
          }),
        );
      }
    }
  }

  return { units, combatLogEntries, detonations };
}
