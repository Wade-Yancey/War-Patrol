/**
 * Destroyer + fleet-sub deck-gun resolve (surface engagement).
 * Volleys (15 shells/min each, 1–3 per turn) resolve as AOE beaten zones —
 * one GT visual per volley, not per shell.
 */
import { nanoid } from 'nanoid';
import {
  DECK_GUN_FIRE_STAGGER_SEC,
  DECK_GUN_HIT_AUDIO_DELAY_SEC,
  applyHealthDamageResult,
  buildDeckGunFireBlock,
  canDeckGunFireFromDepth,
  clampDeckGunVolleyCount,
  consumeDeckGunShells,
  deckGunMissBand,
  deckGunShellsForVolleys,
  deckGunVolleyFireFractions,
  formatDeckGunFireBlockNotice,
  formatTorpedoMissDistance,
  healthDamageApplied,
  isDeckGunHull,
  makeDetonationEvent,
  formatContactDesignation,
  normalizeDeckGunFireOrder,
  normalizeHeading,
  resolveDeckGunVolley,
  type DeckGunFireOrder,
  type LatLonDepth,
  type UnitState,
  type WeaponDetonationEvent,
  type CombatLogEntry,
} from '@war-patrol/shared';
import { logCasualtyEffects, logLine } from './combatLog.js';

export type DeckGunCombatResolveResult = {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
  detonations: WeaponDetonationEvent[];
};

type PendingVolleys = {
  firerId: string;
  fire: DeckGunFireOrder;
  volleyCount: number;
};

/**
 * Resolve pending `orders.fireDeckGun` after kinematics.
 * Consumes {@link deckGunShellsForVolleys} shells; submerged fleet boats block
 * with no ammo spent. Each volley is one AOE resolve + one muzzle / splash cue.
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

  const pending: PendingVolleys[] = [];

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
          logLine({
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
        const volleyCount = clampDeckGunVolleyCount(fire.volleyCount ?? fire.shotCount, next);
        if (volleyCount > 0) {
          const shells = deckGunShellsForVolleys(volleyCount);
          next = consumeDeckGunShells(next, shells);
          if (next.deckGunFireBlock) {
            const { deckGunFireBlock: _cleared, ...rest } = next;
            next = rest as UnitState;
          }
          pending.push({
            firerId: unit.id,
            fire: { ...fire, volleyCount },
            volleyCount,
          });
          const contactTag = formatContactDesignation(fire.targetLabelN);
          const volleyLabel = volleyCount > 1 ? ` ×${volleyCount} volleys` : ' ×1 volley';
          combatLogEntries.push(
            logLine({
              kind: 'deck_gun_fire',
              turnNumber,
              gameTimeSeconds,
              actor: unit,
              summary: `${unit.name} fired deck gun${volleyLabel} (${shells} shells) · ${contactTag} (crew RNG)`,
            }),
          );
          // One muzzle report per volley (cannon WAV), staggered for counting.
          // aimHeading filled at volley resolve from crew aim; muzzle cue uses
          // own heading as a placeholder until the first splash lands.
          for (let i = 0; i < volleyCount; i++) {
            detonations.push(
              makeDetonationEvent({
                id: `dgfire-${nanoid(8)}`,
                kind: 'deck_gun_fire',
                position: { ...unit.position, depth: 0 },
                turnNumber,
                firerUnitId: unit.id,
                aimHeading: normalizeHeading(unit.heading),
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
    const fractions = deckGunVolleyFireFractions(salvo.volleyCount);
    for (let i = 0; i < salvo.volleyCount; i++) {
      const fireFrac = fractions[i] ?? 0;
      const result = resolveDeckGunVolley({
        firer,
        fire: salvo.fire,
        contacts: units,
        startPositions,
        turnLengthSeconds,
        seed: `${firer.id}|deckgun|${turnNumber}|v${i}`,
        fireTurnFraction: fireFrac,
      });
      const fireLabel = String(Math.round(normalizeHeading(result.fireHeading))).padStart(3, '0');
      const contactTag = formatContactDesignation(salvo.fire.targetLabelN);
      const volleyTag =
        salvo.volleyCount > 1 ? ` v${i + 1}/${salvo.volleyCount}` : '';
      const fireAudioDelay = i * DECK_GUN_FIRE_STAGGER_SEC;

      if (result.outcome === 'hit' && result.hits.length > 0) {
        const hitNames: string[] = [];
        let primaryDetId: string | undefined;
        for (const hit of result.hits) {
          const target = units.find((u) => u.id === hit.unitId);
          if (!target) continue;
          const { unit: damaged, effects } = applyHealthDamageResult(target, hit.damage);
          const applied = healthDamageApplied(target, damaged);
          units = units.map((u) => (u.id === damaged.id ? damaged : u));
          if (applied <= 0) continue;
          const detId = `dghit-${nanoid(8)}`;
          if (!primaryDetId) primaryDetId = detId;
          // One AOE visual per volley — only the primary (closest) hit emits a
          // splash circle; further targets share combat-log lines only.
          if (hit.unitId === result.hitUnitId) {
            detonations.push(
              makeDetonationEvent({
                id: detId,
                kind: 'deck_gun_hit',
                position: result.impact,
                turnNumber,
                firerUnitId: firer.id,
                targetUnitId: damaged.id,
                aimHeading: result.fireHeading,
                radiusM: result.radiusM,
                audioDelaySec: fireAudioDelay + DECK_GUN_HIT_AUDIO_DELAY_SEC,
              }),
            );
          }
          hitNames.push(`${target.name} −${applied}`);
          combatLogEntries.push(
            logLine({
              kind: 'deck_gun_hit',
              turnNumber,
              gameTimeSeconds,
              actor: firer,
              target: damaged,
              damage: applied,
              summary: `${firer.name} deck gun HIT${volleyTag} ${target.name} −${applied} HP (${contactTag} · FIRE ${fireLabel}° · AOE ${Math.round(result.radiusM)} m · miss ${hit.missDistanceM.toFixed(0)} m)`,
              sourceDetonationId: primaryDetId ?? detId,
            }),
          );
          combatLogEntries.push(
            ...logCasualtyEffects(damaged, effects, {
              turnNumber,
              gameTimeSeconds,
              actor: firer,
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
                actor: firer,
                summary: `${damaged.name} SUNK / destroyed`,
              }),
            );
          }
        }
        // If every hit applied 0 HP (already sunk), still drop a miss-style cue.
        if (!primaryDetId && hitNames.length === 0) {
          const detId = `dgmiss-${nanoid(8)}`;
          detonations.push(
            makeDetonationEvent({
              id: detId,
              kind: 'deck_gun_miss',
              position: result.impact,
              turnNumber,
              firerUnitId: firer.id,
              aimHeading: result.fireHeading,
              radiusM: result.radiusM,
            }),
          );
        }
      } else {
        const cpaLabel =
          result.closestApproachUnitName && Number.isFinite(result.missDistanceM)
            ? ` — CPA ${result.closestApproachUnitName} ${formatTorpedoMissDistance(result.missDistanceM)} (${deckGunMissBand(result.missDistanceM)} miss)`
            : result.outcome === 'out_of_range'
              ? ' — no range solution'
              : ' — no surface target in AOE';
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
            radiusM: result.radiusM,
          }),
        );
        combatLogEntries.push(
          logLine({
            kind: 'deck_gun_miss',
            turnNumber,
            gameTimeSeconds,
            actor: firer,
            target: result.closestApproachUnitId
              ? units.find((u) => u.id === result.closestApproachUnitId)
              : undefined,
            summary: `${firer.name} deck gun MISS${volleyTag} (${contactTag} · FIRE ${fireLabel}° · AOE ${Math.round(result.radiusM)} m)${cpaLabel}`,
            sourceDetonationId: detId,
          }),
        );
      }
    }
  }

  return { units, combatLogEntries, detonations };
}
