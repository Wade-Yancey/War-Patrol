/**
 * Umpire vessel standing orders — intercept / weapon attack / evade (zigzag).
 * Ships & submarines only; aircraft keep their own attack / loiter path.
 * Attack is weapon-specific (guns / DC / torpedoes) — umpire picks the weapon.
 */
import {
  DEFAULT_TURN_LENGTH_SECONDS,
  KNOTS_TO_MPS,
  RADAR_SURFACE_DEPTH_M,
} from './constants.js';
import { bearingRangeNm, clamp, moveAlongHeading, normalizeHeading } from './geo.js';
import {
  canDropDepthCharges,
  canFireDeckGun,
  canFireTorpedoFromRoom,
  checkTorpedoOrderArc,
  DECK_GUN_MAX_RANGE_NM,
  depthChargeCountFromOrder,
  depthChargePatternForCount,
  isDeckGunHull,
  isDeckGunTarget,
  isDestroyerDcHull,
  isFleetSubTorpedoHull,
  maxDeckGunShotsPerTurn,
  segmentClosestPoint,
  TORPEDO_MAX_RUN_NM,
  unitLengthBeam,
} from './weapons.js';
import type {
  DepthChargeDropOrder,
  DeckGunFireOrder,
  HullClass,
  LatLonDepth,
  TorpedoFireOrder,
  TorpedoRoomId,
  UnitOrders,
  UnitState,
  VesselStandingMode,
  VesselStandingOrder,
  VesselType,
} from './types.js';

/** Preferred EOT while intercepting (standard ahead — close without flank). */
export const VESSEL_INTERCEPT_EOT = 'ahead_full' as const;

/** Preferred EOT while attacking / prosecuting (flank). */
export const VESSEL_ATTACK_EOT = 'ahead_flank' as const;

/** Preferred EOT while evading (full — keep way on for zigzag). */
export const VESSEL_EVADE_EOT = 'ahead_full' as const;

/**
 * Zigzag amplitude (±°) relative to base course.
 * Each resolve steers base ± amplitude, alternating legs (period = 2 turns).
 */
export const VESSEL_EVADE_ZIGZAG_AMPLITUDE_DEG = 30;

/**
 * Destroyer ASW auto-drop gate (horizontal meters) for Attack (DC).
 * Measured as **CPA along this turn's firer move segment** (not only the
 * turn-start plot). Flank simple-pursuit often overshoots: start/end can sit
 * outside this radius while the along-track DC trail still passes over the
 * sub — gating on path CPA is what makes Attack (DC) actually drop.
 */
export const VESSEL_ATTACK_DC_RANGE_M = 600;

/** Deck-gun auto-fire gate (nm) for Attack (guns) — inside max gun range. */
export const VESSEL_ATTACK_GUN_RANGE_NM = 4;

/** Torpedo auto-fire gate (nm) for Attack (torpedoes) — inside fish max run. */
export const VESSEL_ATTACK_TORP_RANGE_NM = Math.min(2.5, TORPEDO_MAX_RUN_NM);

/** Weapon keyed by standing attack mode (excludes intercept / evade). */
export type VesselStandingWeapon = 'guns' | 'dc' | 'torpedoes';

export function canOrderVesselStanding(
  unit: Pick<UnitState, 'type' | 'condition'>,
): boolean {
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return false;
  return unit.type === 'Ship' || unit.type === 'Submarine';
}

/** Valid target for vessel intercept / attack (not aircraft, afloat). */
export function isVesselStandingTarget(
  unit: Pick<UnitState, 'type' | 'condition'> | undefined,
): boolean {
  if (!unit) return false;
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return false;
  if (unit.type === 'Aircraft') return false;
  return true;
}

/** True when mode is one of the weapon-specific Attack orders. */
export function isVesselStandingAttackMode(mode: VesselStandingMode): boolean {
  return (
    mode === 'attack_guns' || mode === 'attack_dc' || mode === 'attack_torpedoes'
  );
}

export function vesselStandingWeaponForMode(
  mode: VesselStandingMode,
): VesselStandingWeapon | null {
  if (mode === 'attack_guns') return 'guns';
  if (mode === 'attack_dc') return 'dc';
  if (mode === 'attack_torpedoes') return 'torpedoes';
  return null;
}

/**
 * Class-appropriate Attack buttons (like aircraft bomb vs strafe).
 * Destroyers: guns + DC. Fleet subs: guns + torpedoes. Others: none.
 */
export function vesselStandingAttackModesForClass(
  hullClass: HullClass,
  vesselType?: VesselType,
): Extract<
  VesselStandingMode,
  'attack_guns' | 'attack_dc' | 'attack_torpedoes'
>[] {
  const stub = { class: hullClass, type: vesselType ?? 'Ship' } as const;
  const modes: Extract<
    VesselStandingMode,
    'attack_guns' | 'attack_dc' | 'attack_torpedoes'
  >[] = [];
  if (isDeckGunHull(stub)) modes.push('attack_guns');
  if (isDestroyerDcHull(stub)) modes.push('attack_dc');
  if (isFleetSubTorpedoHull(stub)) modes.push('attack_torpedoes');
  return modes;
}

/** Full standing-order button list for a hull (Intercept + weapons + Evade). */
export function vesselStandingModesForUnit(
  unit: Pick<UnitState, 'class' | 'type'>,
): VesselStandingMode[] {
  return [
    'intercept',
    ...vesselStandingAttackModesForClass(unit.class, unit.type),
    'evade',
  ];
}

export function isVesselStandingModeAvailable(
  unit: Pick<UnitState, 'class' | 'type'>,
  mode: VesselStandingMode,
): boolean {
  return vesselStandingModesForUnit(unit).includes(mode);
}

export function normalizeVesselStandingMode(raw: unknown): VesselStandingMode {
  if (raw === 'attack_guns' || raw === 'guns') return 'attack_guns';
  if (raw === 'attack_dc' || raw === 'dc' || raw === 'depth_charges') {
    return 'attack_dc';
  }
  if (
    raw === 'attack_torpedoes' ||
    raw === 'torpedoes' ||
    raw === 'torpedo' ||
    raw === 'torp'
  ) {
    return 'attack_torpedoes';
  }
  // Legacy generic Attack (#201) → guns (UI no longer offers it).
  if (raw === 'attack') return 'attack_guns';
  if (raw === 'evade') return 'evade';
  return 'intercept';
}

export function formatVesselStandingModeLabel(mode: VesselStandingMode): string {
  if (mode === 'attack_guns') return 'attack (guns)';
  if (mode === 'attack_dc') return 'attack (DC)';
  if (mode === 'attack_torpedoes') return 'attack (torpedoes)';
  if (mode === 'evade') return 'evade';
  return 'intercept';
}

/** Compact GT / pending-order tag (INT / GUN / DC / TORP / EVA). */
export function formatVesselStandingModeTag(mode: VesselStandingMode): string {
  if (mode === 'attack_guns') return 'GUN';
  if (mode === 'attack_dc') return 'DC';
  if (mode === 'attack_torpedoes') return 'TORP';
  if (mode === 'evade') return 'EVA';
  return 'INT';
}

export function normalizeVesselStandingOrder(
  raw: VesselStandingOrder | null | undefined,
): VesselStandingOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const mode = normalizeVesselStandingMode(raw.mode);
  const targetUnitId = String(raw.targetUnitId ?? '').trim() || undefined;
  const next: VesselStandingOrder = { mode };
  if (targetUnitId) next.targetUnitId = targetUnitId;
  if (mode === 'evade') {
    if (typeof raw.evadeBaseCourse === 'number' && Number.isFinite(raw.evadeBaseCourse)) {
      next.evadeBaseCourse = normalizeHeading(raw.evadeBaseCourse);
    }
    next.evadeLeg = raw.evadeLeg === 1 ? 1 : 0;
  }
  return next;
}

/** Course that steers the vessel toward the target plot (simple pursuit). */
export function vesselInterceptOrderedCourse(
  ownPos: UnitState['position'],
  targetPos: UnitState['position'],
): number {
  return bearingRangeNm(ownPos, targetPos).bearing;
}

/**
 * Evade base course: away from threat when a target is set; else current helm.
 */
export function vesselEvadeBaseCourse(opts: {
  unit: Pick<UnitState, 'heading' | 'orderedCourse' | 'position'>;
  threat?: Pick<UnitState, 'position'> | null;
  existingBase?: number;
}): number {
  if (opts.threat) {
    const towardThreat = bearingRangeNm(opts.unit.position, opts.threat.position).bearing;
    return normalizeHeading(towardThreat + 180);
  }
  if (typeof opts.existingBase === 'number' && Number.isFinite(opts.existingBase)) {
    return normalizeHeading(opts.existingBase);
  }
  const helm =
    typeof opts.unit.orderedCourse === 'number'
      ? opts.unit.orderedCourse
      : opts.unit.heading;
  return normalizeHeading(helm);
}

/**
 * Zigzag ordered course for this resolve.
 * Pattern: base ± {@link VESSEL_EVADE_ZIGZAG_AMPLITUDE_DEG}, alternating each turn
 * (leg 0 = port / −amp, leg 1 = starboard / +amp). Period = 2 resolves.
 */
export function vesselEvadeZigzagCourse(baseCourse: number, evadeLeg: 0 | 1): number {
  const sign = evadeLeg === 1 ? 1 : -1;
  return normalizeHeading(baseCourse + sign * VESSEL_EVADE_ZIGZAG_AMPLITUDE_DEG);
}

function hasOneShotWeaponOrder(orders: UnitOrders): boolean {
  return Boolean(orders.fireTorpedo || orders.dropDepthCharges || orders.fireDeckGun);
}

/** Shortest-arc heading step (local copy — avoids kinematics ↔ vesselStanding cycle). */
function turnTowardHeading(current: number, desired: number, maxDelta: number): number {
  const cur = normalizeHeading(current);
  const des = normalizeHeading(desired);
  let delta = des - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const applied = clamp(delta, -maxDelta, maxDelta);
  return normalizeHeading(cur + applied);
}

/**
 * Lightweight firer end-plot for Attack DC CPA (matches turnEngine move segment
 * closely enough for the drop gate — yaw cap + current way-on distance).
 * Does not import kinematics (that module already calls applyVesselStandingOrders).
 */
export function estimateVesselStandingMoveEnd(
  unit: Pick<UnitState, 'position' | 'heading' | 'speed' | 'turnRate'>,
  orderedCourse: number,
  turnLengthSeconds: number,
): LatLonDepth {
  const seconds = Math.max(0, turnLengthSeconds);
  const maxDelta = unit.turnRate * (seconds / 60);
  const heading = turnTowardHeading(unit.heading, orderedCourse, maxDelta);
  const speed = Math.abs(unit.speed);
  const distance = speed * KNOTS_TO_MPS * seconds;
  if (distance <= 0) return { ...unit.position };
  const moveHeading = unit.speed >= 0 ? heading : normalizeHeading(heading + 180);
  return moveAlongHeading(unit.position, moveHeading, distance);
}

/**
 * Horizontal CPA (meters) of the firer's this-turn move segment to the target
 * plot. Used for standing Attack (DC) auto-queue.
 */
export function vesselAttackDepthChargePathCpaM(
  firer: Pick<UnitState, 'position' | 'heading' | 'speed' | 'turnRate'>,
  target: Pick<UnitState, 'position'>,
  orderedCourse: number,
  turnLengthSeconds: number = DEFAULT_TURN_LENGTH_SECONDS,
): number {
  const end = estimateVesselStandingMoveEnd(firer, orderedCourse, turnLengthSeconds);
  return segmentClosestPoint(firer.position, end, target.position).missM;
}

function buildTruthDeckGunOrder(
  firer: UnitState,
  target: UnitState,
): DeckGunFireOrder | null {
  if (!canFireDeckGun(firer) || !isDeckGunTarget(target)) return null;
  const { bearing, rangeNm } = bearingRangeNm(firer.position, target.position);
  if (rangeNm > VESSEL_ATTACK_GUN_RANGE_NM || rangeNm > DECK_GUN_MAX_RANGE_NM) {
    return null;
  }
  const maxShots = maxDeckGunShotsPerTurn(firer);
  const load = Math.max(0, Math.floor(Number(firer.deckGunLoad) || 0));
  const shotCount = Math.max(1, Math.min(maxShots, load));
  return {
    aimHeading: bearing,
    estimatedCourse: normalizeHeading(target.heading),
    estimatedSpeedKn: Math.abs(target.speed),
    estimatedRangeNm: rangeNm,
    shotCount,
  };
}

function buildTruthDepthChargeOrder(
  firer: UnitState,
  target: UnitState,
  orderedCourse: number,
  turnLengthSeconds: number,
): DepthChargeDropOrder | null {
  if (!isDestroyerDcHull(firer) || !canDropDepthCharges(firer)) return null;
  if (target.type !== 'Submarine') return null;
  // Submerged / PD / deep — anything deeper than radar surface band.
  // Surfaced subs are deck-gun targets, not DC.
  if (target.position.depth <= RADAR_SURFACE_DEPTH_M) return null;
  const cpaM = vesselAttackDepthChargePathCpaM(
    firer,
    target,
    orderedCourse,
    turnLengthSeconds,
  );
  if (cpaM > VESSEL_ATTACK_DC_RANGE_M) return null;
  const load = Math.max(0, Math.floor(Number(firer.depthChargeLoad) || 0));
  const want = load >= 6 ? 6 : load >= 4 ? 4 : load >= 2 ? 2 : 1;
  const count = depthChargeCountFromOrder({ count: want }, load);
  return {
    count,
    pattern: depthChargePatternForCount(count),
    depthSettingM: Math.max(10, Math.round(target.position.depth / 10) * 10),
  };
}

function buildTruthTorpedoOrder(
  firer: UnitState,
  target: UnitState,
): TorpedoFireOrder | null {
  if (!isFleetSubTorpedoHull(firer)) return null;
  const { bearing, rangeNm } = bearingRangeNm(firer.position, target.position);
  if (rangeNm <= 0 || rangeNm > VESSEL_ATTACK_TORP_RANGE_NM) return null;
  // Torpedoes need a waterborne hull — skip aircraft (already filtered) and
  // very deep? Fish run shallow; still allow vs surface ships / PD boats.
  if (target.type === 'Aircraft') return null;
  const { lengthM } = unitLengthBeam(target);
  const rooms: TorpedoRoomId[] = ['forward', 'aft'];
  for (const room of rooms) {
    if (!canFireTorpedoFromRoom(firer, room)) continue;
    const check = checkTorpedoOrderArc({
      ownHeadingDeg: firer.heading,
      room,
      aimHeading: bearing,
      estimatedCourse: normalizeHeading(target.heading),
      estimatedSpeedKn: Math.abs(target.speed),
      estimatedRangeNm: rangeNm,
      spreadCount: 1,
      spreadDeg: 0,
    });
    if (!check.ok) continue;
    return {
      room,
      aimHeading: bearing,
      estimatedCourse: normalizeHeading(target.heading),
      estimatedSpeedKn: Math.abs(target.speed),
      estimatedRangeNm: rangeNm,
      estimatedLengthM: lengthM,
      spreadCount: 1,
      spreadDeg: 0,
    };
  }
  return null;
}

/**
 * Auto-queue one weapon order for a standing Attack when in engagement range.
 * Prosecutes **only** the requested weapon (guns / DC / torpedoes) — no
 * priority fallback across weapons. Uses ground-truth aim (umpire NPC).
 * DC gate uses path CPA along this turn's move (see {@link VESSEL_ATTACK_DC_RANGE_M}).
 */
export function vesselAttackWeaponOrder(
  firer: UnitState,
  target: UnitState,
  opts: {
    weapon: VesselStandingWeapon;
    orderedCourse?: number;
    turnLengthSeconds?: number;
  },
): Partial<Pick<UnitOrders, 'fireTorpedo' | 'dropDepthCharges' | 'fireDeckGun'>> {
  if (hasOneShotWeaponOrder(firer.orders)) return {};

  const course =
    typeof opts.orderedCourse === 'number'
      ? opts.orderedCourse
      : vesselInterceptOrderedCourse(firer.position, target.position);
  const turnLengthSeconds = opts.turnLengthSeconds ?? DEFAULT_TURN_LENGTH_SECONDS;

  if (opts.weapon === 'dc') {
    const dc = buildTruthDepthChargeOrder(firer, target, course, turnLengthSeconds);
    return dc ? { dropDepthCharges: dc } : {};
  }
  if (opts.weapon === 'guns') {
    const gun = buildTruthDeckGunOrder(firer, target);
    return gun ? { fireDeckGun: gun } : {};
  }
  if (opts.weapon === 'torpedoes') {
    const torp = buildTruthTorpedoOrder(firer, target);
    return torp ? { fireTorpedo: torp } : {};
  }
  return {};
}

/**
 * Inject course (+ preferred EOT when unset) for ships/subs with vesselStanding.
 * Clears the order when the required target is gone / invalid.
 * Attack modes may also queue that weapon's one-shot order when in engage range.
 * Attack (guns) expires once a deck-gun salvo is queued (or already pending) —
 * one-shot like aircraft bombing. Attack (DC) / Attack (torpedoes) keep
 * prosecuting until Clear / target gone.
 * Evade advances zigzag leg each call (period 2 turns).
 *
 * @param turnLengthSeconds In-game seconds for this resolve — used by Attack DC
 *   path-CPA gating (defaults to {@link DEFAULT_TURN_LENGTH_SECONDS}).
 */
export function applyVesselStandingOrders(
  units: UnitState[],
  turnLengthSeconds: number = DEFAULT_TURN_LENGTH_SECONDS,
): UnitState[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const turnLen = Number.isFinite(turnLengthSeconds)
    ? Math.max(0, turnLengthSeconds)
    : DEFAULT_TURN_LENGTH_SECONDS;
  return units.map((unit) => {
    if (!unit.orders.vesselStanding) return unit;
    if (!canOrderVesselStanding(unit)) {
      const { vesselStanding: _v, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    const standing = normalizeVesselStandingOrder(unit.orders.vesselStanding);
    if (!standing) {
      const { vesselStanding: _v, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    // Drop weapon modes the hull cannot employ (e.g. legacy Attack on a merchant).
    if (
      isVesselStandingAttackMode(standing.mode) &&
      !isVesselStandingModeAvailable(unit, standing.mode)
    ) {
      const { vesselStanding: _v, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    const targetId = standing.targetUnitId?.trim() || '';
    const target = targetId ? byId.get(targetId) : undefined;
    const needsTarget =
      standing.mode === 'intercept' || isVesselStandingAttackMode(standing.mode);

    if (needsTarget && !isVesselStandingTarget(target)) {
      const { vesselStanding: _v, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    if (standing.mode === 'evade') {
      const threatOk = targetId ? isVesselStandingTarget(target) : false;
      const threat = threatOk ? target : null;
      const base = vesselEvadeBaseCourse({
        unit,
        threat,
        existingBase: standing.evadeBaseCourse,
      });
      const leg: 0 | 1 = standing.evadeLeg === 1 ? 1 : 0;
      const course = vesselEvadeZigzagCourse(base, leg);
      const nextStanding: VesselStandingOrder = {
        mode: 'evade',
        evadeBaseCourse: base,
        evadeLeg: leg === 0 ? 1 : 0,
        ...(threatOk && targetId ? { targetUnitId: targetId } : {}),
      };
      const nextOrders: UnitOrders = {
        ...unit.orders,
        vesselStanding: nextStanding,
        course,
        ...(unit.orders.eot === undefined ? { eot: VESSEL_EVADE_EOT } : {}),
      };
      return { ...unit, orders: nextOrders };
    }

    // intercept / attack_* — target validated above
    const course = vesselInterceptOrderedCourse(unit.position, target!.position);
    const attacking = isVesselStandingAttackMode(standing.mode);
    const preferredEot = attacking ? VESSEL_ATTACK_EOT : VESSEL_INTERCEPT_EOT;
    const weapon = vesselStandingWeaponForMode(standing.mode);
    const weaponPatch =
      weapon != null
        ? vesselAttackWeaponOrder(unit, target!, {
            weapon,
            orderedCourse: course,
            turnLengthSeconds: turnLen,
          })
        : {};
    const nextOrders: UnitOrders = {
      ...unit.orders,
      vesselStanding: {
        mode: standing.mode,
        targetUnitId: targetId,
      },
      course,
      ...(unit.orders.eot === undefined ? { eot: preferredEot } : {}),
      ...weaponPatch,
    };
    // Guns: expire after the salvo is away this resolve (queued now or already
    // pending). Leaves DC / torpedo standing orders prosecuting.
    if (
      standing.mode === 'attack_guns' &&
      (nextOrders.fireDeckGun || unit.orders.fireDeckGun)
    ) {
      delete nextOrders.vesselStanding;
    }
    return { ...unit, orders: nextOrders };
  });
}
