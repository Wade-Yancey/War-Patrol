import type { HullClass } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Approximate WWII / early–Cold-War **max speed** by taxonomic class (knots).
 * Round numbers — not trial-data precision. Ships/subs: historical hulls;
 * aircraft: prop-era TAS rounded into the same knot model the movement engine uses.
 *
 * Representative references (order-of-magnitude):
 * - Fleet Submarine ~ Gato surfaced ~20 kn (submerged much slower; not modeled yet)
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

/** Class default EOT speed-step fraction (0–1 of maxSpeed per turn). */
export function defaultSpeedStepFraction(hullClass: HullClass): number {
  return CLASS_SPEED_STEP_FRACTION[hullClass] ?? DEFAULT_SPEED_STEP;
}

/**
 * Resolve maxSpeed: explicit positive override wins; else class enum default.
 * Accepts hull class or legacy type strings via identity resolve.
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
