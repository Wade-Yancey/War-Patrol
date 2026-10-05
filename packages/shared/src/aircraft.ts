/**
 * NPC aircraft helpers — bomb magazine, loiter / attack standing orders.
 * Attack CPA / damage math lives in weapons.ts (shared with resolve).
 */
import { METERS_PER_NM } from './constants.js';
import { AIRCRAFT_BAND_EOT } from './eot.js';
import { bearingRangeNm, moveAlongHeading, normalizeHeading } from './geo.js';
import type {
  AircraftAttackOrder,
  AircraftLoiterState,
  LatLonDepth,
  UnitState,
} from './types.js';

/** Ready bombs per aircraft (museum stub — one drop then umpire restock). */
export const AIRCRAFT_BOMB_LOAD = 1;

/** Default orbit radius when starting loiter on top of the center (~2 nm). */
export const AIRCRAFT_LOITER_DEFAULT_RADIUS_M = 2 * METERS_PER_NM;

/** Clamp orbit radius so CAP stays useful on the GT map. */
export const AIRCRAFT_LOITER_MIN_RADIUS_M = 0.6 * METERS_PER_NM;
export const AIRCRAFT_LOITER_MAX_RADIUS_M = 6 * METERS_PER_NM;

/** Arc advanced around the orbit each resolve (degrees) — coarse station-keeping. */
export const AIRCRAFT_LOITER_ARC_DEG_PER_TURN = 55;

export function isAircraftBombHull(unit: Pick<UnitState, 'type'>): boolean {
  return unit.type === 'Aircraft';
}

/** Normalize bomb magazine (Aircraft = 0…{@link AIRCRAFT_BOMB_LOAD}; others 0). */
export function resolveBombMagazineState(
  unit: Pick<UnitState, 'type'> & Partial<Pick<UnitState, 'bombLoad'>>,
): Pick<UnitState, 'bombLoad'> {
  if (!isAircraftBombHull(unit)) {
    return { bombLoad: 0 };
  }
  if (typeof unit.bombLoad === 'number') {
    return {
      bombLoad: Math.min(
        AIRCRAFT_BOMB_LOAD,
        Math.max(0, Math.floor(unit.bombLoad)),
      ),
    };
  }
  return { bombLoad: AIRCRAFT_BOMB_LOAD };
}

export function rearmBombLoad(unit: UnitState): UnitState {
  if (!isAircraftBombHull(unit)) {
    return { ...unit, bombLoad: 0 };
  }
  return { ...unit, bombLoad: AIRCRAFT_BOMB_LOAD };
}

export function consumeBombLoad(unit: UnitState): UnitState {
  if (!isAircraftBombHull(unit)) return unit;
  const have = Math.max(0, Math.floor(Number(unit.bombLoad) || 0));
  return { ...unit, bombLoad: Math.max(0, have - 1) };
}

export function hasBombLoad(unit: Pick<UnitState, 'type' | 'bombLoad'>): boolean {
  return isAircraftBombHull(unit) && Math.max(0, Math.floor(Number(unit.bombLoad) || 0)) > 0;
}

export function clampAircraftLoiterRadiusM(radiusM: number): number {
  const r = Number.isFinite(radiusM) ? radiusM : AIRCRAFT_LOITER_DEFAULT_RADIUS_M;
  return Math.min(
    AIRCRAFT_LOITER_MAX_RADIUS_M,
    Math.max(AIRCRAFT_LOITER_MIN_RADIUS_M, r),
  );
}

/**
 * Build a standing loiter orbit from current plot (and optional parent hull).
 * Radius snaps to current range-to-center when far enough; else default.
 */
export function buildAircraftLoiterState(opts: {
  aircraft: Pick<UnitState, 'position'>;
  center: LatLonDepth;
  centerUnitId?: string;
  radiusM?: number;
}): AircraftLoiterState {
  const { rangeNm } = bearingRangeNm(opts.center, opts.aircraft.position);
  const fromRange = rangeNm * METERS_PER_NM;
  const radiusM = clampAircraftLoiterRadiusM(
    opts.radiusM ??
      (fromRange >= AIRCRAFT_LOITER_MIN_RADIUS_M
        ? fromRange
        : AIRCRAFT_LOITER_DEFAULT_RADIUS_M),
  );
  return {
    centerLat: opts.center.lat,
    centerLon: opts.center.lon,
    radiusM,
    ...(opts.centerUnitId?.trim()
      ? { centerUnitId: opts.centerUnitId.trim() }
      : {}),
  };
}

/**
 * Ordered course that walks the aircraft around the orbit (aim ahead on the circle).
 */
export function aircraftLoiterOrderedCourse(
  aircraftPos: LatLonDepth,
  center: LatLonDepth,
  radiusM: number,
  _turnLengthSeconds?: number,
): number {
  const radius = clampAircraftLoiterRadiusM(radiusM);
  const { bearing: fromCenter } = bearingRangeNm(center, aircraftPos);
  const aimBearing = normalizeHeading(fromCenter + AIRCRAFT_LOITER_ARC_DEG_PER_TURN);
  const aimPoint = moveAlongHeading(
    { lat: center.lat, lon: center.lon, depth: 0 },
    aimBearing,
    radius,
  );
  return bearingRangeNm(aircraftPos, aimPoint).bearing;
}

/** Preferred EOT when a loiter standing order is active (loiter speed band). */
export function aircraftLoiterEot() {
  return AIRCRAFT_BAND_EOT.loiter;
}

/** Preferred EOT when a standing attack order is active (full speed band). */
export function aircraftAttackEot() {
  return AIRCRAFT_BAND_EOT.full;
}

/**
 * Absolute heading error (deg) onto an attack course — used to throttle speed
 * while breaking CAP so full-band pursuit does not fly a huge off-axis loop.
 */
export function aircraftAttackHeadingErrorDeg(
  headingDeg: number,
  attackCourseDeg: number,
): number {
  let delta = normalizeHeading(attackCourseDeg) - normalizeHeading(headingDeg);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return Math.abs(delta);
}

/**
 * Off-axis threshold (deg): above this, attack inject uses cruise instead of full
 * so the plane can turn onto the run without rocketing away from the target.
 */
export const AIRCRAFT_ATTACK_ALIGN_DEG = 45;

/**
 * Large off-axis threshold (deg): above this, use loiter band (tightest museum
 * turn geometry — turn rate is deg/min, not speed-dependent).
 */
export const AIRCRAFT_ATTACK_HARD_TURN_DEG = 90;

/**
 * Pursuit EOT for a standing attack: full when roughly aligned, otherwise a
 * slower band so break-from-loiter acquires the target instead of orbiting away.
 */
export function aircraftAttackPursuitEot(
  headingDeg: number,
  attackCourseDeg: number,
) {
  const err = aircraftAttackHeadingErrorDeg(headingDeg, attackCourseDeg);
  if (err > AIRCRAFT_ATTACK_HARD_TURN_DEG) return AIRCRAFT_BAND_EOT.loiter;
  if (err > AIRCRAFT_ATTACK_ALIGN_DEG) return AIRCRAFT_BAND_EOT.cruise;
  return AIRCRAFT_BAND_EOT.full;
}

/**
 * Resolve loiter center for this turn (tracks parent hull when set).
 */
export function resolveAircraftLoiterCenter(
  loiter: AircraftLoiterState,
  unitsById: Map<string, UnitState>,
): LatLonDepth {
  if (loiter.centerUnitId) {
    const parent = unitsById.get(loiter.centerUnitId);
    if (parent && parent.condition !== 'sunk' && parent.condition !== 'sinking') {
      return {
        lat: parent.position.lat,
        lon: parent.position.lon,
        depth: 0,
      };
    }
  }
  return { lat: loiter.centerLat, lon: loiter.centerLon, depth: 0 };
}

/**
 * True when a hull can still be the target of a standing aircraft attack
 * (mirrors weapons.isAircraftAttackTarget — kept local to avoid cycle).
 */
export function isStandingAircraftAttackTarget(
  unit: Pick<UnitState, 'type' | 'condition'> | undefined,
): boolean {
  if (!unit) return false;
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return false;
  if (unit.type === 'Aircraft') return false;
  return true;
}

/** Course that steers the aircraft toward the attack target plot. */
export function aircraftAttackOrderedCourse(
  aircraftPos: LatLonDepth,
  targetPos: LatLonDepth,
): number {
  return bearingRangeNm(aircraftPos, targetPos).bearing;
}

/**
 * Inject course + pursuit-band EOT for aircraft with a standing attack.
 * Clears the attack when the target is gone / invalid, or bombing has no bomb left.
 * Attack steering always wins over loiter for the same resolve (and overwrites any
 * leftover loiter-band EOT so CAP cannot pin the plane at orbit speed).
 */
export function applyAircraftAttackStandingOrders(units: UnitState[]): UnitState[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  return units.map((unit) => {
    if (unit.type !== 'Aircraft' || !unit.orders.aircraftAttack) return unit;
    if (unit.condition === 'sunk' || unit.condition === 'sinking') {
      const { aircraftAttack: _a, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    const attack = unit.orders.aircraftAttack;
    const targetId = String(attack.targetUnitId ?? '').trim();
    const target = targetId ? byId.get(targetId) : undefined;

    if (!isStandingAircraftAttackTarget(target)) {
      const { aircraftAttack: _a, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    if (attack.mode === 'bombing_run' && !hasBombLoad(unit)) {
      const { aircraftAttack: _a, ...rest } = unit.orders;
      return { ...unit, orders: rest };
    }

    const course = aircraftAttackOrderedCourse(unit.position, target!.position);
    const nextOrders: UnitState['orders'] = {
      ...unit.orders,
      aircraftAttack: {
        mode: attack.mode,
        targetUnitId: targetId,
      } satisfies AircraftAttackOrder,
      course,
      // Always re-assert pursuit EOT — do not keep a prior loiter-band leftover.
      eot: aircraftAttackPursuitEot(unit.heading, course),
    };
    return { ...unit, orders: nextOrders };
  });
}

/**
 * Inject course (+ loiter-band EOT when unset) for aircraft with a standing loiter.
 * Skips when a standing attack order is active (attack steering wins).
 */
export function applyAircraftLoiterStandingOrders(units: UnitState[]): UnitState[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  return units.map((unit) => {
    if (unit.type !== 'Aircraft' || !unit.aircraftLoiter) return unit;
    if (unit.condition === 'sunk' || unit.condition === 'sinking') return unit;
    if (unit.orders.aircraftAttack) return unit;

    const loiter = unit.aircraftLoiter;
    const center = resolveAircraftLoiterCenter(loiter, byId);
    const course = aircraftLoiterOrderedCourse(
      unit.position,
      center,
      loiter.radiusM,
    );
    const nextOrders = {
      ...unit.orders,
      course,
      ...(unit.orders.eot === undefined ? { eot: aircraftLoiterEot() } : {}),
    };
    return {
      ...unit,
      orders: nextOrders,
      aircraftLoiter: {
        ...loiter,
        centerLat: center.lat,
        centerLon: center.lon,
        radiusM: clampAircraftLoiterRadiusM(loiter.radiusM),
      },
    };
  });
}

/**
 * Apply standing aircraft orders in resolve / GT-prediction order:
 * attack steering first, then loiter (loiter yields while attack is active so the
 * plane breaks CAP to prosecute, then resumes the orbit after the attack clears).
 */
export function applyAircraftStandingOrders(units: UnitState[]): UnitState[] {
  return applyAircraftLoiterStandingOrders(applyAircraftAttackStandingOrders(units));
}
