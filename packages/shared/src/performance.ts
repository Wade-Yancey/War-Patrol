import { RADAR_SURFACE_DEPTH_M } from './constants.js';
import type { HullClass, VesselType } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Approximate WWII / early–Cold-War **max speed** by taxonomic class (knots).
 * Round numbers — not trial-data precision. Ships/subs: historical hulls;
 * aircraft: prop-era TAS rounded into the same knot model the movement engine uses.
 *
 * Representative references (order-of-magnitude):
 * - Fleet Submarine ~ Gato surfaced ~20 kn; submerged ~9 kn
 * - Destroyer ~ Fletcher ~36 kn
 * - Cruiser ~ Cleveland / Baltimore ~32 kn
 * - Aircraft Carrier ~ Essex ~33 kn
 * - Merchant ~ Liberty ~11 kn
 * - Oiler ~ Cimarron fleet oiler ~18 kn
 * - Battleship ~ Iowa ~33 kn
 * - Fighter ~ Hellcat / Corsair max ~320 kn TAS
 * - Bomber ~ Avenger / medium bomber max ~250 kn TAS
 */
export const CLASS_MAX_SPEED_KNOTS: Record<HullClass, number> = {
  'Fleet Submarine': 20,
  Destroyer: 36,
  Cruiser: 32,
  'Aircraft Carrier': 33,
  Merchant: 11,
  Oiler: 18,
  Battleship: 33,
  Fighter: 320,
  Bomber: 250,
};

/** @deprecated Prefer {@link CLASS_MAX_SPEED_KNOTS}. */
export const CLASS_DEFAULT_MAX_SPEED = CLASS_MAX_SPEED_KNOTS;

/**
 * Fleet-submarine submerged max (knots). Same depth band as radar surface:
 * depth > {@link RADAR_SURFACE_DEPTH_M} → submerged.
 */
export const SUBMERGED_MAX_SPEED_KNOTS = 9;

/**
 * Fraction of maxSpeed the unit may change toward the EOT target **per resolve**.
 * Heavier / slower-accelerating classes step less; aircraft and destroyers more.
 * Replaces the former flat 0.35 for all hulls.
 */
export const CLASS_SPEED_STEP_FRACTION: Record<HullClass, number> = {
  'Fleet Submarine': 0.35,
  Destroyer: 0.4,
  Cruiser: 0.3,
  'Aircraft Carrier': 0.25,
  Merchant: 0.2,
  Oiler: 0.25,
  Battleship: 0.2,
  Fighter: 0.5,
  Bomber: 0.4,
};

const DEFAULT_MAX_SPEED = CLASS_MAX_SPEED_KNOTS.Destroyer;
const DEFAULT_SPEED_STEP = 0.35;

/** Class default max speed (knots). */
export function defaultMaxSpeed(hullClass: HullClass): number {
  return CLASS_MAX_SPEED_KNOTS[hullClass] ?? DEFAULT_MAX_SPEED;
}

/**
 * Class default max speed accepting optional / legacy class strings (#22 API).
 * Invalid → Destroyer default (36), not a silent 20.
 */
export function defaultMaxSpeedForClass(hullClass: HullClass | string | undefined): number {
  if (isHullClass(hullClass)) return defaultMaxSpeed(hullClass);
  const { class: resolved } = resolveVesselIdentity({ class: hullClass, type: hullClass });
  return defaultMaxSpeed(resolved);
}

/** Class default EOT speed-step fraction (0–1 of maxSpeed per turn). */
export function defaultSpeedStepFraction(hullClass: HullClass): number {
  return CLASS_SPEED_STEP_FRACTION[hullClass] ?? DEFAULT_SPEED_STEP;
}

/**
 * Resolve maxSpeed: explicit positive override wins; else class enum default.
 * This is the **surfaced / hull** max stored on the unit — see {@link effectiveMaxSpeed}.
 */
export function resolveMaxSpeed(opts: {
  maxSpeed?: number;
  class?: HullClass | string;
  type?: string;
}): number {
  if (typeof opts.maxSpeed === 'number' && Number.isFinite(opts.maxSpeed) && opts.maxSpeed > 0) {
    return opts.maxSpeed;
  }
  const { class: hullClass } = resolveVesselIdentity({
    type: opts.type ?? opts.class,
    class: isHullClass(opts.class) ? opts.class : undefined,
  });
  return defaultMaxSpeed(hullClass);
}

/** Speed-step fraction for a class (or identity hint). */
export function resolveSpeedStepFraction(opts: {
  class?: HullClass | string;
  type?: string;
}): number {
  const { class: hullClass } = resolveVesselIdentity({
    type: opts.type ?? opts.class,
    class: isHullClass(opts.class) ? opts.class : undefined,
  });
  return defaultSpeedStepFraction(hullClass);
}

/** True when a submarine is deep enough that submerged performance applies. */
export function isSubmergedForSpeed(
  type: VesselType | string | undefined,
  depth: number | undefined,
): boolean {
  if (type !== 'Submarine') return false;
  return typeof depth === 'number' && depth > RADAR_SURFACE_DEPTH_M;
}

/**
 * Runtime speed ceiling (knots): hull maxSpeed, or submerged cap (~9 kn) for
 * submarines deeper than the radar surface band. Does not mutate unit.maxSpeed.
 */
export function effectiveMaxSpeed(opts: {
  type?: VesselType | string;
  maxSpeed: number;
  depth?: number;
}): number {
  const hull = Math.abs(opts.maxSpeed);
  if (!Number.isFinite(hull) || hull <= 0) return 0;
  if (isSubmergedForSpeed(opts.type, opts.depth)) {
    return Math.min(hull, SUBMERGED_MAX_SPEED_KNOTS);
  }
  return hull;
}

/**
 * Effective max speed for umpire edit / display.
 * Prefer the unit's stored maxSpeed when the draft class matches the unit;
 * otherwise use the historical class-table default.
 * For submarines, draft depth > surface band further caps to submerged max.
 */
export function editMaxSpeedForClass(opts: {
  draftClass: HullClass;
  unitClass: HullClass;
  unitMaxSpeed: number;
  draftType?: VesselType;
  draftDepth?: number;
}): number {
  const hull =
    opts.draftClass === opts.unitClass && opts.unitMaxSpeed > 0
      ? opts.unitMaxSpeed
      : defaultMaxSpeed(opts.draftClass);
  return effectiveMaxSpeed({
    type: opts.draftType ?? (opts.draftClass === 'Fleet Submarine' ? 'Submarine' : undefined),
    maxSpeed: hull,
    depth: opts.draftDepth,
  });
}

/** Clamp signed speed (knots) to ±maxSpeed. */
export function clampSpeedToMax(speed: number, maxSpeed: number): number {
  const cap = Math.abs(maxSpeed);
  if (!Number.isFinite(speed) || !Number.isFinite(cap) || cap <= 0) return 0;
  if (speed > cap) return cap;
  if (speed < -cap) return -cap;
  return speed;
}
