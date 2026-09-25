/**
 * Advance weapon tracks during turn resolve and apply hit/detonation resolution.
 */
import { nanoid } from 'nanoid';
import {
  RADAR_SURFACE_DEPTH_M,
  WEAPON_SUBSTEPS,
  advanceDepthCharge,
  advanceTorpedo,
  aircraftAttackClosestApproach,
  applyHealthDamageResult,
  healthDamageApplied,
  canDropDepthCharges,
  canFireTorpedoFromRoom,
  canOrderAircraftAttack,
  clampDepthChargeSetting,
  clampTorpedoSpreadCount,
  clampTorpedoSpreadDeg,
  TORPEDO_DEFAULT_DEPTH_M,
  createDepthChargeTracks,
  createTorpedoTrack,
  depthChargePatternCount,
  formatAircraftAttackModeLabel,
  formatCasualtySummary,
  formatTorpedoMissLogSummary,
  horizontalMissMeters,
  isAircraftAttackTarget,
  isDepthChargeTarget,
  isTorpedoTarget,
  lerpLatLonDepth,
  makeDetonationEvent,
  torpedoHitAudioDelaySec,
  normalizeAircraftAttackMode,
  normalizeDepthChargePattern,
  normalizeHeading,
  normalizeTorpedoRoomId,
  recordTorpedoClosestApproach,
  resolveAircraftAttackEffect,
  resolveDepthChargeEffect,
  resolveTorpedoHit,
  segmentClosestPoint,
  buildTorpedoArcBlock,
  checkTorpedoOrderArc,
  formatTorpedoArcRejectMessage,
  truncateTorpedoAtHit,
  unitLengthBeam,
  advanceWeaponReloads,
  consumeTorpedoRoom,
  consumeDepthChargeRack,
  torpedoRoomReady,
  type CasualtyEffect,
  type CombatLogEntry,
  type CombatLogKind,
  type DepthChargeTrack,
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

/** Exported for immediate (non-turn-resolve) combat log lines, e.g. gopher tasks. */
export function logLine(opts: {
  kind: CombatLogKind;
  turnNumber: number;
  gameTimeSeconds: number;
  summary: string;
  actor?: UnitState;
  target?: UnitState;
  damage?: number;
  /** Bridge / audio detonation id this combat effect came from. */
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
    logLine({
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

  // --- Launch from orders (consume load; clear weapon order fields after) ---
  const launchedFish: TorpedoTrack[] = [];
  const launchedCharges: DepthChargeTrack[] = [];

  units = units.map((unit) => {
    let next = advanceWeaponReloads(unit);
    const orders = unit.orders;

    if (
      orders.fireTorpedo &&
      canFireTorpedoFromRoom(next, normalizeTorpedoRoomId(orders.fireTorpedo.room))
    ) {
      const fire = orders.fireTorpedo;
      const room = normalizeTorpedoRoomId(fire.room);
      const runDepthM = TORPEDO_DEFAULT_DEPTH_M;
      const want = clampTorpedoSpreadCount(fire.spreadCount);
      const have = torpedoRoomReady(next, room);
      const count = Math.min(want, have);
      const spacing = clampTorpedoSpreadDeg(fire.spreadDeg);
      const estCourse = Number(fire.estimatedCourse) || 0;
      const estSpd = Number(fire.estimatedSpeedKn) || 0;
      const estRange = Number(fire.estimatedRangeNm) || 0;
      const estLen = Number(fire.estimatedLengthM) || 0;
      // Intercept from player solution (aim + course/speed/range) — never sim truth.
      // Arc uses post-kinematics heading (tubes point with the hull at launch).
      const arc = checkTorpedoOrderArc({
        ownHeadingDeg: unit.heading,
        room,
        aimHeading: fire.aimHeading,
        estimatedCourse: estCourse,
        estimatedSpeedKn: estSpd,
        estimatedRangeNm: estRange,
        spreadCount: count,
        spreadDeg: spacing,
      });
      if (!arc.ok) {
        // Ordering validated the arc at queue time; the hull may have turned
        // since. Drop the salvo with no fish spent and tell the crew.
        next = {
          ...next,
          torpedoArcBlock: buildTorpedoArcBlock(arc, turnNumber, unit.heading),
        };
        combatLogEntries.push(
          logLine({
            kind: 'torpedo_launch',
            turnNumber,
            gameTimeSeconds,
            actor: unit,
            summary: `${unit.name} torpedo order blocked — ${formatTorpedoArcRejectMessage(arc)}`,
          }),
        );
      } else {
        const fireHdg = arc.fireHeading;
        const headings = arc.headings;
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
        next = consumeTorpedoRoom(next, room, count);
        if (next.torpedoArcBlock) {
          const { torpedoArcBlock: _cleared, ...rest } = next;
          next = rest as UnitState;
        }
        const fanLabel =
          count > 1
            ? ` spread ×${count} @${spacing}° · center `
            : ' ';
        const roomLabel = room === 'aft' ? 'aft' : 'fwd';
        const aimLabel = String(Math.round(normalizeHeading(fire.aimHeading))).padStart(3, '0');
        const fireLabel = String(Math.round(normalizeHeading(fireHdg))).padStart(3, '0');
        combatLogEntries.push(
          logLine({
            kind: 'torpedo_launch',
            turnNumber,
            gameTimeSeconds,
            actor: unit,
            summary: `${unit.name} fired torpedo${fanLabel}FIRE ${fireLabel}° (aim ${aimLabel}°) · ${count} fish · ${roomLabel}`,
          }),
        );
      }
    }

    if (orders.dropDepthCharges && canDropDepthCharges(next)) {
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
        next = consumeDepthChargeRack(next, need);
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

  // --- Aircraft attack runs (CPA along this turn's path; no persistent tracks) ---
  {
    const pendingAttacks: Array<{
      attackerId: string;
      mode: 'intercept' | 'bombing_run';
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

    if (pendingAttacks.length) {
      const unitMap = new Map(units.map((u) => [u.id, u]));
      for (const pending of pendingAttacks) {
        const attacker = unitMap.get(pending.attackerId);
        if (!attacker) continue;
        const target = unitMap.get(pending.targetUnitId);
        const modeLabel = formatAircraftAttackModeLabel(pending.mode);
        combatLogEntries.push(
          logLine({
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
        const clearedAttacker = {
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
            logLine({
              kind: 'aircraft_attack_miss',
              turnNumber,
              gameTimeSeconds,
              actor: clearedAttacker,
              summary: `${attacker.name} ${modeLabel} aborted — no valid target`,
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
                summary: `${attacker.name} ${modeLabel} HIT ${target.name} −${applied} HP (CPA ${approach.missM.toFixed(0)} m)`,
              }),
            );
            combatLogEntries.push(
              ...logCasualtyEffects(damaged, effects, {
                turnNumber,
                gameTimeSeconds,
                actor: clearedAttacker,
              }),
            );
            if (damaged.condition === 'sunk') {
              combatLogEntries.push(
                logLine({
                  kind: 'unit_sunk',
                  turnNumber,
                  gameTimeSeconds,
                  target: damaged,
                  actor: clearedAttacker,
                  summary: `${damaged.name} SUNK / destroyed`,
                }),
              );
            }
          }
        } else {
          const reason =
            effect.outcome === 'ineffective'
              ? pending.mode === 'intercept'
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
              summary: `${attacker.name} ${modeLabel} vs ${target.name} — ${reason} (CPA ${approach.missM.toFixed(0)} m)`,
            }),
          );
        }
      }
    }
  }

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

  /**
   * Targets (and the firer's own hull, for arc/launch bookkeeping) move
   * across the *whole* turn during kinematics, before this substep loop
   * ever runs — `units` already holds each hull's end-of-turn position.
   * Without this, every contact sits frozen at its final position for
   * the entire weapon run, so a fish arriving mid-turn checks against a
   * target that (from its perspective) hasn't moved yet this turn but
   * (from the sim's) has already finished moving — a silent, otherwise
   * unaccounted-for miss even when the player's solution was exact.
   * Interpolate straight-line between the pre-move snapshot and the
   * final position so collision checks see the target where it truly
   * was at that fraction of the turn.
   */
  const interpolatedPosition = (unitId: string, endPosition: LatLonDepth, frac: number): LatLonDepth => {
    const start = startPositions?.get(unitId);
    if (!start) return endPosition;
    return lerpLatLonDepth(start, endPosition, frac);
  };

  for (let step = 0; step < WEAPON_SUBSTEPS; step++) {
    const unitMap = byId();
    // Fraction of the turn elapsed once this substep's advance completes.
    const frac = (step + 1) / WEAPON_SUBSTEPS;

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
        const targetPos = interpolatedPosition(uid, target.position, frac);
        const closest = segmentClosestPoint(before, advanced.position, targetPos);
        // CPA is always vs nearest eligible contact (not the aimed solution target).
        advanced = recordTorpedoClosestApproach(advanced, closest.missM, uid, target.name);

        // Exhausted fish still update CPA on the last segment, then log miss.
        if (advanced.status !== 'running') continue;

        const depthOk =
          target.type === 'Ship' || targetPos.depth <= RADAR_SURFACE_DEPTH_M
            ? advanced.runDepthM <= 8
            : Math.abs(advanced.runDepthM - targetPos.depth) <= 6;
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
          const { unit: damaged, effects } = applyHealthDamageResult(target, damage);
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
              ...logCasualtyEffects(damaged, effects, {
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
              firerName: unitMap.get(fish.firerUnitId)?.name ?? fish.firerUnitId,
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
          summary: `DC detonated at ${Math.round(advanced.depthSettingM)} m (from ${unitMap.get(advanced.firerUnitId)?.name ?? advanced.firerUnitId})`,
        }),
      );
      for (const [uid, target] of unitMap) {
        if (!isDepthChargeTarget(target)) continue;
        const targetPos = interpolatedPosition(uid, target.position, frac);
        const horiz = horizontalMissMeters(advanced.position, targetPos);
        const depthErr = advanced.depthSettingM - targetPos.depth;
        const { damage } = resolveDepthChargeEffect({
          horizontalMissM: horiz,
          depthErrorM: depthErr,
          pattern: advanced.pattern,
          seed: `${advanced.id}|${uid}|${turnNumber}`,
        });
        if (damage > 0) {
          const { unit: damaged, effects } = applyHealthDamageResult(target, damage);
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
              ...logCasualtyEffects(damaged, effects, {
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

