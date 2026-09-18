import { RADAR_MAX_RANGE_NM } from './constants.js';
import type { RadarSignature, SensorDef, UnitState, VesselType } from './types.js';

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

/**
 * Default installed sensors by vessel type (ARCH-STA-03/04 spirit).
 * Destroyers/cruisers get surface-search radar; submarines do not by default.
 */
export function defaultSensors(type: VesselType): SensorDef[] {
  switch (type) {
    case 'destroyer':
    case 'cruiser':
      return [{ kind: 'radar', maxRangeNm: RADAR_MAX_RANGE_NM }];
    case 'submarine':
    case 'merchant':
    case 'other':
    default:
      return [];
  }
}

/** Own-ship radar set, if installed. */
export function findRadarSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'radar');
}

export function hasRadarSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findRadarSensor(unit));
}
