import { RADAR_MAX_RANGE_NM, RADAR_SURFACE_DEPTH_M } from './constants.js';
import type { LatLonDepth, RadarSignature, SensorDef, UnitState, VesselType } from './types.js';

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
 * Default installed sensors by vessel type.
 * Wade (2026-09-18): destroyers and submarines both get radar for play
 * (overrides earlier ARCH-STA-04 “subs have no radar” default).
 */
export function defaultSensors(type: VesselType): SensorDef[] {
  switch (type) {
    case 'destroyer':
    case 'cruiser':
    case 'submarine':
      return [{ kind: 'radar', maxRangeNm: RADAR_MAX_RANGE_NM }];
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

/** True when depth is shallow enough for radar use / radar reflection. */
export function isRadarSurfaced(position: Pick<LatLonDepth, 'depth'>): boolean {
  return position.depth <= RADAR_SURFACE_DEPTH_M;
}
