/**
 * Advance weapon tracks during turn resolve and apply hit/detonation resolution.
 */
import { nanoid } from 'nanoid';
import {
  RADAR_SURFACE_DEPTH_M,
  WEAPON_SUBSTEPS,
  advanceDepthCharge,
  advanceTorpedo,
  TORPEDO_HIT_DAMAGE,
  applyHealthDamage,
  canDropDepthCharges,
  canFireTorpedo,
  clampDepthChargeSetting,
  clampTorpedoDepth,
  createDepthChargeTracks,
  createTorpedoTrack,
  depthChargePatternCount,
  horizontalMissMeters,
  isDepthChargeTarget,
  isTorpedoTarget,
  makeDetonationEvent,
  normalizeDepthChargePattern,
  normalizeHeading,
  normalizeSolutionPlotDuration,
  resolveDepthChargeEffect,
  resolveTorpedoHit,
  segmentClosestMissM,
  unitLengthBeam,
  type DepthChargeTrack,
  type GameSave,
  type TorpedoTrack,
  type UnitState,
  type WeaponDetonationEvent,
} from '@war-patrol/shared';

const DETONATION_RETENTION_TURNS = 2;

export type WeaponsResolveResult = {
  units: UnitState[];
  torpedoes: TorpedoTrack[];
  depthCharges: DepthChargeTrack[];
  recentDetonations: WeaponDetonationEvent[];
};

/**
 * Launch pending weapon orders from post-helm unit positions, then substep
 * advance tracks and resolve hits / detonations for this turn.
 */
export function resolveWeaponsForTurn(
  unitsIn: UnitState[],
  priorTorpedoes: TorpedoTrack[],
  priorDepthCharges: DepthChargeTrack[],
  priorDetonations: WeaponDetonationEvent[],
  turnNumber: number,
  turnLengthSeconds: number,
): WeaponsResolveResult {
  let units = unitsIn.map((u) => ({ ...u }));
  const byId = () => new Map(units.map((u) => [u.id, u]));

  // --- Launch from orders (consume load; clear weapon order fields after) ---
  const launchedFish: TorpedoTrack[] = [];
  const launchedCharges: DepthChargeTrack[] = [];

  units = units.map((unit) => {
    let next = unit;
    const orders = unit.orders;

    if (orders.fireTorpedo && canFireTorpedo(unit)) {
      const fire = orders.fireTorpedo;
      const fish = createTorpedoTrack({
        id: `t-${nanoid(8)}`,
        firerUnitId: unit.id,
        position: {
          ...unit.position,
          // Fish leaves from keel depth but runs at ordered depth.
          depth: clampTorpedoDepth(fire.runDepthM),
        },
        heading: normalizeHeading(fire.aimHeading),
        runDepthM: fire.runDepthM,
        launchedTurn: turnNumber,
        estimatedLengthM: Number(fire.estimatedLengthM) || 0,
        estimatedSpeedKn: Number(fire.estimatedSpeedKn) || 0,
        solutionPlot: normalizeSolutionPlotDuration(fire.solutionPlot),
      });
      launchedFish.push(fish);
      next = { ...next, torpedoLoad: Math.max(0, (next.torpedoLoad ?? 0) - 1) };
    }

    if (orders.dropDepthCharges && canDropDepthCharges(unit)) {
      const drop = orders.dropDepthCharges;
      const pattern = normalizeDepthChargePattern(drop.pattern);
      const need = depthChargePatternCount(pattern);
      const have = next.depthChargeLoad ?? 0;
      if (have >= need) {
        const tracks = createDepthChargeTracks({
          idPrefix: `dc-${nanoid(6)}`,
          firerUnitId: unit.id,
          dropPosition: { ...unit.position, depth: 0 },
          dropHeading: unit.heading,
          pattern,
          depthSettingM: clampDepthChargeSetting(drop.depthSettingM),
          launchedTurn: turnNumber,
        });
        launchedCharges.push(...tracks);
        next = { ...next, depthChargeLoad: have - need };
      }
    }

    // Strip weapon orders so they do not re-fire (helm orders cleared elsewhere).
    if (next.orders.fireTorpedo || next.orders.dropDepthCharges) {
      const { fireTorpedo: _f, dropDepthCharges: _d, ...rest } = next.orders;
      next = { ...next, orders: rest };
    }
    return next;
  });

  let torpedoes: TorpedoTrack[] = [
    ...priorTorpedoes.filter((t) => t.status === 'running'),
    ...launchedFish,
  ];
  let depthCharges: DepthChargeTrack[] = [
    ...priorDepthCharges.filter((c) => c.status === 'sinking'),
    ...launchedCharges,
  ];

  const newDetonations: WeaponDetonationEvent[] = [];
  const dt = turnLengthSeconds / WEAPON_SUBSTEPS;

  for (let step = 0; step < WEAPON_SUBSTEPS; step++) {
    const unitMap = byId();

    // Torpedoes: move + hit check vs surface targets
    torpedoes = torpedoes.map((fish) => {
      if (fish.status !== 'running') return fish;
      const before = fish.position;
      let advanced = advanceTorpedo(fish, dt);
      if (advanced.status !== 'running' && advanced.status !== 'expired') return advanced;

      for (const [uid, target] of unitMap) {
        if (uid === fish.firerUnitId) continue;
        if (!isTorpedoTarget(target)) continue;
        const miss = segmentClosestMissM(before, advanced.position, target.position);
        const depthOk =
          target.type === 'Ship' ||
          target.position.depth <= RADAR_SURFACE_DEPTH_M
            ? advanced.runDepthM <= 8
            : Math.abs(advanced.runDepthM - target.position.depth) <= 6;
        const { lengthM } = unitLengthBeam(target);
        const roll = resolveTorpedoHit({
          missDistanceM: miss,
          fishHeading: advanced.heading,
          targetHeading: target.heading,
          trueLengthM: lengthM,
          trueSpeedKn: target.speed,
          estimatedLengthM: advanced.estimatedLengthM,
          estimatedSpeedKn: advanced.estimatedSpeedKn,
          solutionPlot: advanced.solutionPlot,
          depthOk,
          seed: `${fish.id}|${uid}|${turnNumber}|${step}`,
        });
        if (roll.hit) {
          const damaged = applyHealthDamage(target, TORPEDO_HIT_DAMAGE);
          units = units.map((u) => (u.id === uid ? damaged : u));
          unitMap.set(uid, damaged);
          return {
            ...advanced,
            status: 'hit' as const,
            hitUnitId: uid,
            remainingRunNm: advanced.remainingRunNm,
          };
        }
      }
      return advanced;
    });

    // Depth charges: sink + detonate
    depthCharges = depthCharges.map((charge) => {
      if (charge.status !== 'sinking') return charge;
      const advanced = advanceDepthCharge(charge, dt);
      if (advanced.status !== 'detonated') return advanced;

      newDetonations.push(
        makeDetonationEvent({
          id: `det-${advanced.id}`,
          position: advanced.position,
          turnNumber,
          firerUnitId: advanced.firerUnitId,
        }),
      );
      for (const [uid, target] of unitMap) {
        if (!isDepthChargeTarget(target)) continue;
        const horiz = horizontalMissMeters(advanced.position, target.position);
        const depthErr = advanced.depthSettingM - target.position.depth;
        const { damage } = resolveDepthChargeEffect({
          horizontalMissM: horiz,
          depthErrorM: depthErr,
          pattern: advanced.pattern,
          seed: `${advanced.id}|${uid}|${turnNumber}`,
        });
        if (damage > 0) {
          const damaged = applyHealthDamage(target, damage);
          units = units.map((u) => (u.id === uid ? damaged : u));
          unitMap.set(uid, damaged);
        }
      }
      return { ...advanced, status: 'spent' as const };
    });
  }
  // Keep recently finished tracks briefly for umpire GT, then prune.
  const keptFish = [
    ...torpedoes.filter((t) => t.status === 'running'),
    ...torpedoes.filter(
      (t) =>
        (t.status === 'hit' || t.status === 'expired') && t.launchedTurn >= turnNumber - 1,
    ),
  ];
  const keptCharges = [
    ...depthCharges.filter((c) => c.status === 'sinking'),
    ...depthCharges.filter(
      (c) =>
        (c.status === 'detonated' || c.status === 'spent') &&
        c.launchedTurn >= turnNumber - 1,
    ),
  ];

  const recentDetonations = [
    ...priorDetonations.filter((d) => d.turnNumber >= turnNumber - DETONATION_RETENTION_TURNS),
    ...newDetonations,
  ];

  return {
    units,
    torpedoes: keptFish,
    depthCharges: keptCharges,
    recentDetonations,
  };
}

/** Ensure save weapon arrays exist (migration). */
export function emptyWeaponsState(): Pick<
  GameSave,
  'torpedoes' | 'depthCharges' | 'recentDetonations'
> {
  return { torpedoes: [], depthCharges: [], recentDetonations: [] };
}
