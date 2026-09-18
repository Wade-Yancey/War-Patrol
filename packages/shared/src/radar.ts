import type { RadarSignature, VesselType } from './types.js';

/** Sensible class defaults when scenario/library omit radarSignature. */
export function defaultRadarSignature(type: VesselType): RadarSignature {
  switch (type) {
    case 'submarine':
      return 'small';
    case 'destroyer':
    case 'other':
      return 'medium';
    case 'cruiser':
    case 'merchant':
      return 'large';
    default:
      return 'medium';
  }
}
