/**
 * Advance weapon tracks during turn resolve and apply hit/detonation resolution.
 */
import { nanoid } from 'nanoid';
import {
  RADAR_SURFACE_DEPTH_M,
  WEAPON_SUBSTEPS,
  advanceDepthCharge,
  advanceTorpedo,
  applyHealthDamage,
  healthDamageApplied,
  canDropDepthCharges,
  canFireTorpedo,
  clampDepthChargeSetting,
  clampTorpedoSpreadCount,
  clampTorpedoSpreadDeg,
  TORPEDO_DEFAULT_DEPTH_M,
  createDepthChargeTracks,
  createTorpedoTrack,
  depthChargePatternCount,
  formatTorpedoMissLogSummary,
  horizontalMissMeters,
  isDepthChargeTarget,
  isTorpedoTarget,
  makeDetonationEvent,
  torpedoHitAudioDelaySec,
  normalizeDepthChargePattern,
  normalizeHeading,
  recordTorpedoClosestApproach,
  resolveDepthChargeEffect,
  resolveTorpedoHit,
  segmentClosestPoint,
  torpedoFireHeadingFromSolution,
  torpedoSpreadHeadings,
  truncateTorpedoAtHit,
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
  /** Bridge / audio detonation id this combat effect came from. */
  sourceDetonationId?: string;
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
  };
}

function logSubsystemCasualties(
  before: UnitState,
  after: UnitState,
  opts: {
    turnNumber: number;
    gameTimeSeconds: number;
    actor?: UnitState;
    sourceDetonationId?: string;
  },
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
        sourceDetonationId: opts.sourceDetonationId,
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
        sourceDetonationId: opts.sourceDetonationId,
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
      const runDepthM = TORPEDO_DEFAULT_DEPTH_M;
      const want = clampTorpedoSpreadCount(fire.spreadCount);
      const have = next.torpedoLoad ?? 0;
      const count = Math.min(want, have);
      const spacing = clampTorpedoSpreadDeg(fire.spreadDeg);
      const estCourse = Number(fire.estimatedCourse) || 0;
      const estSpd = Number(fire.estimatedSpeedKn) || 0;
      const estRange = Number(fire.estimatedRangeNm) || 0;
      const estLen = Number(fire.estimatedLengthM) || 0;
      // Intercept from player solution (aim + course/speed/range) — never sim truth.
      const solution = torpedoFireHeadingFromSolution({
        aimHeading: fire.aimHeading,
        estimatedCourse: estCourse,
        estimatedSpeedKn: estSpd,
        estimatedRangeNm: estRange,
      });
      const fireHdg = solution.fireHeading;
      const headings = torpedoSpreadHeadings(fireHdg, count, spacing);
      for (const hdg of headings) {
        const fish = createTorpedoTrack({
          id: `t-${nanoid(8)}`,
          firerUnitId: unit.id,
          position: {
            ...unit.position,
            depth: runDepthM,
          },
          heading: normalizeHeading(hdg),
          runDepthM,
          launchedTurn: turnNumber,
          estimatedCourse: estCourse,
          estimatedSpeedKn: estSpd,
          estimatedRangeNm: estRange,
          estimatedLengthM: estLen,
        });
        launchedFish.push(fish);
      }
      next = { ...next, torpedoLoad: Math.max(0, have - count) };
      const fanLabel =
        count > 1
          ? ` spread ×${count} @${spacing}° · center `
          : ' ';
      const aimLabel = String(Math.round(normalizeHeading(fire.aimHeading))).padStart(3, '0');
      const fireLabel = String(Math.round(normalizeHeading(fireHdg))).padStart(3, '0');
      combatLogEntries.push(
        logLine({
          kind: 'torpedo_launch',
          turnNumber,
          gameTimeSeconds,
          actor: unit,
          summary: `${unit.name} fired torpedo${fanLabel}FIRE ${fireLabel}° (aim ${aimLabel}°) · ${count} fish`,
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

  // Historical fish (hit / expired / duded) stay on the umpire GT map forever.
  const historicalFish = priorTorpedoes.filter((t) => t.status !== 'running');
  // Historical DC markers (detonated / spent) stay on the umpire GT map forever (AAR).
  const historicalCharges = priorDepthCharges.filter((c) => c.status !== 'sinking');
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
      // Carry multi-turn CPA onto this substep result before approach checks.
      advanced = {
        ...advanced,
        ...(fish.closestApproachM != null
          ? {
              closestApproachM: fish.closestApproachM,
              closestApproachUnitId: fish.closestApproachUnitId,
              closestApproachUnitName: fish.closestApproachUnitName,
            }
          : {}),
      };

      for (const [uid, target] of unitMap) {
        if (uid === fish.firerUnitId) continue;
        if (!isTorpedoTarget(target)) continue;
        const closest = segmentClosestPoint(before, advanced.position, target.position);
        // CPA is always vs nearest eligible contact (not the aimed solution target).
        advanced = recordTorpedoClosestApproach(advanced, closest.missM, uid, target.name);

        // Exhausted fish still update CPA on the last segment, then log miss.
        if (advanced.status !== 'running') continue;

        const depthOk =
          target.type === 'Ship' || target.position.depth <= RADAR_SURFACE_DEPTH_M
            ? advanced.runDepthM <= 8
            : Math.abs(advanced.runDepthM - target.position.depth) <= 6;
        const { lengthM, beamM } = unitLengthBeam(target);
        const roll = resolveTorpedoHit({
          missDistanceM: closest.missM,
          fishHeading: advanced.heading,
          targetHeading: target.heading,
          trueLengthM: lengthM,
          trueBeamM: beamM,
          estimatedLengthM: fish.estimatedLengthM,
          depthOk,
          seed: `${fish.id}|${uid}|${turnNumber}|${step}`,
        });
        if (roll.dud) {
          const truncated = truncateTorpedoAtHit(
            fish,
            advanced,
            before,
            closest,
            uid,
            'duded',
          );
          combatLogEntries.push(
            logLine({
              kind: 'torpedo_expired',
              turnNumber,
              gameTimeSeconds,
              actor: unitMap.get(fish.firerUnitId),
              target,
              summary: `Torpedo DUD on ${target.name} (aspect ${roll.aspectDeg.toFixed(0)}° · dud ${roll.dudPct.toFixed(0)}%)`,
            }),
          );
          return truncated;
        }
        if (roll.hit) {
          const damage = roll.damage;
          const damaged = applyHealthDamage(target, damage);
          const applied = healthDamageApplied(target, damaged);
          units = units.map((u) => (u.id === uid ? damaged : u));
          unitMap.set(uid, damaged);
          const truncated = truncateTorpedoAtHit(fish, advanced, before, closest, uid, 'hit');
          const hitDetonationId = `thit-${fish.id}`;
          const audioDelaySec = torpedoHitAudioDelaySec(step, closest.t, turnLengthSeconds);
          newDetonations.push(
            makeDetonationEvent({
              id: hitDetonationId,
              kind: 'torpedo_hit',
              position: truncated.position,
              turnNumber,
              firerUnitId: fish.firerUnitId,
              targetUnitId: uid,
              audioDelaySec,
            }),
          );
          // Log HP actually removed (not the roll) so FoW staging matches the bar.
          if (applied > 0) {
            combatLogEntries.push(
              logLine({
                kind: 'torpedo_hit',
                turnNumber,
                gameTimeSeconds,
                actor: unitMap.get(fish.firerUnitId),
                target: damaged,
                damage: applied,
                sourceDetonationId: hitDetonationId,
                summary: `Torpedo HIT ${target.name} (−${applied} HP · aspect ${roll.aspectDeg.toFixed(0)}° · gate ${roll.hitGateM.toFixed(0)} m · L-ID ${(roll.lengthIdScale * 100).toFixed(0)}%)`,
              }),
            );
            combatLogEntries.push(
              ...logSubsystemCasualties(target, damaged, {
                turnNumber,
                gameTimeSeconds,
                actor: unitMap.get(fish.firerUnitId),
                sourceDetonationId: hitDetonationId,
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
                  sourceDetonationId: hitDetonationId,
                  summary: `${damaged.name} SUNK / destroyed`,
                }),
              );
            }
          }
          return truncated;
        }
      }

      if (advanced.status === 'expired' && fish.status === 'running') {
        const cpaTarget =
          advanced.closestApproachUnitId != null
            ? unitMap.get(advanced.closestApproachUnitId)
            : undefined;
        const nearestName = cpaTarget?.name ?? advanced.closestApproachUnitName;
        combatLogEntries.push(
          logLine({
            kind: 'torpedo_miss',
            turnNumber,
            gameTimeSeconds,
            actor: unitMap.get(fish.firerUnitId),
            target: cpaTarget,
            summary: formatTorpedoMissLogSummary({
              firerName: nameOf(fish.firerUnitId),
              targetName: nearestName,
              closestApproachM: advanced.closestApproachM,
            }),
          }),
        );
      }
      return advanced;
    });

    depthCharges = depthCharges.map((charge) => {
      if (charge.status !== 'sinking') return charge;
      const advanced = advanceDepthCharge(charge, dt);
      if (advanced.status !== 'detonated') return advanced;

      const dcDetonationId = `det-${advanced.id}`;
      newDetonations.push(
        makeDetonationEvent({
          id: dcDetonationId,
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
          sourceDetonationId: dcDetonationId,
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
          const applied = healthDamageApplied(target, damaged);
          units = units.map((u) => (u.id === uid ? damaged : u));
          unitMap.set(uid, damaged);
          // Applied HP only — rolled overkill past 0 must not inflate Damage-tab lines
          // or staged hull rewind (#92 presentation).
          if (applied > 0) {
            combatLogEntries.push(
              logLine({
                kind: 'depth_charge_damage',
                turnNumber,
                gameTimeSeconds,
                actor: unitMap.get(advanced.firerUnitId),
                target: damaged,
                damage: applied,
                sourceDetonationId: dcDetonationId,
                summary: `DC effect on ${target.name} −${applied} HP (miss ${horiz.toFixed(0)} m · ΔD ${depthErr.toFixed(0)} m)`,
              }),
            );
            combatLogEntries.push(
              ...logSubsystemCasualties(target, damaged, {
                turnNumber,
                gameTimeSeconds,
                actor: unitMap.get(advanced.firerUnitId),
                sourceDetonationId: dcDetonationId,
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
                  sourceDetonationId: dcDetonationId,
                  summary: `${damaged.name} SUNK / destroyed`,
                }),
              );
            }
          }
        }
      }
      return { ...advanced, status: 'spent' as const };
    });
  }

  // Keep every fish / DC ever launched: active + newly terminal + prior historical trails.
  const keptFish = [...historicalFish, ...torpedoes];
  const keptCharges = [...historicalCharges, ...depthCharges];

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
