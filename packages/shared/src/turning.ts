import { TURN_RATE_DEG_PER_MIN } from './constants.js';
import type { HullClass, RadarSignature } from './types.js';
import { defaultRadarSignature } from './radar.js';

/** Turn rate (deg / in-game minute) from hull size / radar signature. */
export function turnRateForSignature(signature: RadarSignature): number {
  return TURN_RATE_DEG_PER_MIN[signature];
}

/**
 * Resolve class/unit turn rate: explicit override wins; else derive from
 * radarSignature (size proxy). Larger = slower.
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
  const signature =
    opts.radarSignature ?? defaultRadarSignature(opts.class ?? opts.type ?? 'Destroyer');
  return turnRateForSignature(signature);
}
