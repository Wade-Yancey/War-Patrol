import { TURN_RATE_DEG_PER_MIN, TURN_RATE_DEG_PER_MIN_BY_CLASS } from './constants.js';
import type { HullClass, RadarSignature } from './types.js';
import { defaultRadarSignature } from './radar.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Turn rate (deg / in-game minute) from radar signature band (legacy fallback). */
export function turnRateForSignature(signature: RadarSignature): number {
  return TURN_RATE_DEG_PER_MIN[signature];
}

/**
 * Default turn rate (deg / in-game minute) for a hull class: explicit
 * per-class rate wins ({@link TURN_RATE_DEG_PER_MIN_BY_CLASS}); classes not
 * listed there (Fighter, Bomber) fall back to their radarSignature band.
 */
export function defaultTurnRateForClass(hullClassOrType: HullClass | string | undefined): number {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  const perClass = (TURN_RATE_DEG_PER_MIN_BY_CLASS as Partial<Record<HullClass, number>>)[
    hullClass
  ];
  if (typeof perClass === 'number') return perClass;
  return turnRateForSignature(defaultRadarSignature(hullClass));
}

/**
 * Resolve class/unit turn rate: explicit override wins; else derive from
 * hull class (size/maneuverability), not radar signature — see
 * {@link defaultTurnRateForClass}.
 */
export function resolveTurnRate(opts: {
  turnRate?: number;
  radarSignature?: RadarSignature;
  /** Hull class preferred; legacy type strings also accepted. */
  class?: HullClass | string;
  type?: string;
}): number {
  if (typeof opts.turnRate === 'number' && Number.isFinite(opts.turnRate) && opts.turnRate > 0) {
    return opts.turnRate;
  }
  return defaultTurnRateForClass(opts.class ?? opts.type ?? 'Destroyer');
}
