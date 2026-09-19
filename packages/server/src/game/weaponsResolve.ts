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
  type CombatLogEntry,
  type CombatLogKind,
  type DepthChargeTrack,
  type GameSave,
  type LatLonDepth,
  type TorpedoTrack,
  type UnitState,
  type WeaponDetonationEvent,
} from '@war-patrol/shared';

const DETONATION_RETENTION_TURNS = 2;
/** Cap umpire combat log length (oldest dropped). */
const COMBAT_LOG_MAX = 200;

export type WeaponsResolveResult = {
  units: UnitState[];
  torpedoes: TorpedoTrack[];
  depthCharges: DepthChargeTrack[];
  recentDetonations: WeaponDetonationEvent[];
  combatLogEntries: CombatLogEntry[];
};

function logLine(opts: {
  kind: CombatLogKind;
  turnNumber: number;
  gameTimeSeconds: number;
  summary: string;
  actor?: UnitState;
  target?: UnitState;
  damage?: number;
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
  };
}

function logSubsystemCasualties(
  before: UnitState,
  after: UnitState,
  opts: { turnNumber: number; gameTimeSeconds: number; actor?: UnitState },
): CombatLogEntry[] {
  const lines: CombatLogEntry[] = [];
  if (before.subsystems.sensors === 'intact' && after.subsystems.sensors === 'disabled') {
    lines.push(
      logLine({
        kind: 'subsystem_casualty',
        turnNumber: opts.turnNumber,
        gameTimeSeconds: opts.gameTimeSeconds,
        actor: opts.actor,
        target: after,
        summary: `${after.name}: sensors disabled`,
      }),
    );
  }
  if (
    before.subsystems.propulsion === 'intact' &&
    after.subsystems.propulsion === 'disabled'
  ) {
    lines.push(
      logLine({
        kind: 'subsystem_casualty',
        turnNumber: opts.turnNumber,
        gameTimeSeconds: opts.gameTimeSeconds,
        actor: opts.actor,
        target: after,
        summary: `${after.name}: propulsion disabled`,
      }),
    );
  }
  return lines;
}

/**
 * Launch pending weapon orders, then substep-advance tracks and resolve hits.
 *
 * Depth charges release as a **trail along the firer's move** this turn
 * (spaced from pre-resolve → post-resolve position). Torpedoes still leave
 * from the post-resolve keel (fish run continues from there).
 */
export function resolveWeaponsForTurn(
  unitsIn: UnitState[],
  priorTorpedoes: TorpedoTrack[],
  priorDepthCharges: DepthChargeTrack[],
  priorDetonations: WeaponDetonationEvent[],
  turnNumber: number,
  turnLengthSeconds: number,
  gameTimeSeconds: number,
  /** Pre-kinematics positions keyed by unit id (for DC mid-move release). */
  startPositions?: ReadonlyMap<string, LatLonDepth>,
): WeaponsResolveResult {
  let units = unitsIn.map((u) => ({ ...u }));
  const byId = () => new Map(units.map((u) => [u.id, u]));
  const combatLogEntries: CombatLogEntry[] = [];
  const nameOf = (id: string) => byId().get(id)?.name ?? id;

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
      combatLogEntries.push(
        logLine({
          kind: 'torpedo_launch',
          turnNumber,
          gameTimeSeconds,
          actor: unit,
          summary: `${unit.name} fired torpedo HDG ${String(Math.round(fish.heading)).padStart(3, '0')}° · D${fish.runDepthM}m · rem ${fish.remainingRunNm.toFixed(1)} nm`,
        }),
      );
    }

    if (orders.dropDepthCharges && canDropDepthCharges(unit)) {
      const drop = orders.dropDepthCharges;
      const pattern = normalizeDepthChargePattern(drop.pattern);
      const need = depthChargePatternCount(pattern);
      const have = next.depthChargeLoad ?? 0;
      if (have >= need) {
        const start = startPositions?.get(unit.id) ?? unit.position;
        const end = unit.position;
        const tracks = createDepthChargeTracks({
          idPrefix: `dc-${nanoid(6)}`,
          firerUnitId: unit.id,
          startPosition: { ...start, depth: 0 },
          endPosition: { lat: end.lat, lon: end.lon, depth: 0 },
          dropHeading: unit.heading,
          pattern,
          depthSettingM: clampDepthChargeSetting(drop.depthSettingM),
          launchedTurn: turnNumber,
        });
        launchedCharges.push(...tracks);
        next = { ...next, depthChargeLoad: have - need };
        combatLogEntries.push(
          logLine({
            kind: 'depth_charge_drop',
            turnNumber,
            gameTimeSeconds,
            actor: unit,
            summary: `${unit.name} dropped DC ${pattern} ×${tracks.length} · set ${clampDepthChargeSetting(drop.depthSettingM)} m (along-track trail)`,
          }),
        );
      }
    }

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

    torpedoes = torpedoes.map((fish) => {
      if (fish.status !== 'running') return fish;
      const before = fish.position;
      let advanced = advanceTorpedo(fish, dt);
      if (advanced.status === 'expired' && fish.status === 'running') {
        combatLogEntries.push(
          logLine({
            kind: 'torpedo_expired',
            turnNumber,
            gameTimeSeconds,
            actor: unitMap.get(fish.firerUnitId),
            summary: `Torpedo from ${nameOf(fish.firerUnitId)} exhausted run (miss / end)`,
          }),
        );
        return advanced;
      }
      if (advanced.status !== 'running') return advanced;

      for (const [uid, target] of unitMap) {
        if (uid === fish.firerUnitId) continue;
        if (!isTorpedoTarget(target)) continue;
        const miss = segmentClosestMissM(before, advanced.position, target.position);
        const depthOk =
          target.type === 'Ship' || target.position.depth <= RADAR_SURFACE_DEPTH_M
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
          combatLogEntries.push(
            logLine({
              kind: 'torpedo_hit',
              turnNumber,
              gameTimeSeconds,
              actor: unitMap.get(fish.firerUnitId),
              target: damaged,
              damage: TORPEDO_HIT_DAMAGE,
              summary: `Torpedo HIT ${target.name} (−${TORPEDO_HIT_DAMAGE} HP · aspect ${roll.aspectDeg.toFixed(0)}° · p=${roll.hitPct.toFixed(0)}%)`,
            }),
          );
          combatLogEntries.push(
            ...logSubsystemCasualties(target, damaged, {
              turnNumber,
              gameTimeSeconds,
              actor: unitMap.get(fish.firerUnitId),
            }),
          );
          if (damaged.condition === 'sunk') {
            combatLogEntries.push(
              logLine({
                kind: 'unit_sunk',
                turnNumber,
                gameTimeSeconds,
                target: damaged,
                actor: unitMap.get(fish.firerUnitId),
                summary: `${damaged.name} SUNK / destroyed`,
              }),
            );
          }
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
      combatLogEntries.push(
        logLine({
          kind: 'depth_charge_detonation',
          turnNumber,
          gameTimeSeconds,
          actor: unitMap.get(advanced.firerUnitId),
          summary: `DC detonated at ${Math.round(advanced.depthSettingM)} m (from ${nameOf(advanced.firerUnitId)})`,
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
          combatLogEntries.push(
            logLine({
              kind: 'depth_charge_damage',
              turnNumber,
              gameTimeSeconds,
              actor: unitMap.get(advanced.firerUnitId),
              target: damaged,
              damage,
              summary: `DC effect on ${target.name} −${damage} HP (miss ${horiz.toFixed(0)} m · ΔD ${depthErr.toFixed(0)} m)`,
            }),
          );
          combatLogEntries.push(
            ...logSubsystemCasualties(target, damaged, {
              turnNumber,
              gameTimeSeconds,
              actor: unitMap.get(advanced.firerUnitId),
            }),
          );
          if (damaged.condition === 'sunk') {
            combatLogEntries.push(
              logLine({
                kind: 'unit_sunk',
                turnNumber,
                gameTimeSeconds,
                target: damaged,
                actor: unitMap.get(advanced.firerUnitId),
                summary: `${damaged.name} SUNK / destroyed`,
              }),
            );
          }
        }
      }
      return { ...advanced, status: 'spent' as const };
    });
  }

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
    combatLogEntries,
  };
}

/** Merge new combat log lines onto prior log (cap length). */
export function appendCombatLog(
  prior: CombatLogEntry[] | undefined,
  additions: CombatLogEntry[],
): CombatLogEntry[] {
  const next = [...(prior ?? []), ...additions];
  if (next.length <= COMBAT_LOG_MAX) return next;
  return next.slice(next.length - COMBAT_LOG_MAX);
}

/** Ensure save weapon arrays exist (migration). */
export function emptyWeaponsState(): Pick<
  GameSave,
  'torpedoes' | 'depthCharges' | 'recentDetonations' | 'combatLog'
> {
  return { torpedoes: [], depthCharges: [], recentDetonations: [], combatLog: [] };
}
