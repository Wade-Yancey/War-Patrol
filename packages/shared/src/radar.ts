import { RADAR_MAX_RANGE_NM, RADAR_SURFACE_DEPTH_M } from './constants.js';
import { defaultActiveSonarSensor } from './activeSonar.js';
import { defaultHydrophoneSensor } from './hydrophone.js';
import { defaultLookoutSensor } from './periscope.js';
import type { HullClass, LatLonDepth, RadarSignature, SensorDef, UnitState } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Sensible class defaults when scenario/library omit radarSignature. */
export function defaultRadarSignature(
  hullClassOrType: HullClass | string | undefined,
): RadarSignature {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Fleet Submarine':
    case 'Fighter':
    case 'Bomber':
      return 'small';
    case 'Destroyer':
    case 'Merchant':
    case 'Oiler':
      return 'medium';
    case 'Cruiser':
    case 'Aircraft Carrier':
    case 'Battleship':
      return 'large';
    default:
      return 'medium';
  }
}

/**
 * Default installed sensors by hull class.
 * - Destroyer: radar + active search sonar + lookout (no hydrophone)
 * - Fleet Submarine: radar + hydrophone + lookout (periscope)
 * - Other warships: radar only
 */
export function defaultSensors(hullClassOrType: HullClass | string | undefined): SensorDef[] {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Destroyer': {
      const sensors: SensorDef[] = [{ kind: 'radar', maxRangeNm: RADAR_MAX_RANGE_NM }];
      const sonar = defaultActiveSonarSensor(hullClass);
      if (sonar) sensors.push(sonar);
      const lookout = defaultLookoutSensor(hullClass);
      if (lookout) sensors.push(lookout);
      return sensors;
    }
    case 'Fleet Submarine': {
      const sensors: SensorDef[] = [{ kind: 'radar', maxRangeNm: RADAR_MAX_RANGE_NM }];
      const hydro = defaultHydrophoneSensor(hullClass);
      if (hydro) sensors.push(hydro);
      const lookout = defaultLookoutSensor(hullClass);
      if (lookout) sensors.push(lookout);
      return sensors;
    }
    case 'Cruiser':
    case 'Battleship':
    case 'Aircraft Carrier':
      return [{ kind: 'radar', maxRangeNm: RADAR_MAX_RANGE_NM }];
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
