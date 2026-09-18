import {
  ACTIVE_SONAR_HALF_ANGLE_DEG,
  ACTIVE_SONAR_MAX_RANGE_NM,
} from './constants.js';
import { shortestBearingDelta } from './hydrophone.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Own-ship active search sonar set, if installed. */
export function findActiveSonarSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'active_sonar');
}

export function hasActiveSonarSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findActiveSonarSensor(unit));
}

/** Default active-sonar install — destroyers only in v1. */
export function defaultActiveSonarSensor(
  hullClassOrType: HullClass | string | undefined,
): SensorDef | undefined {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  if (hullClass === 'Destroyer') {
    return { kind: 'active_sonar', maxRangeNm: ACTIVE_SONAR_MAX_RANGE_NM };
  }
  return undefined;
}

export function resolveActiveSonarMaxRangeNm(sensor: SensorDef | undefined): number {
  return sensor?.maxRangeNm ?? ACTIVE_SONAR_MAX_RANGE_NM;
}

export function resolveActiveSonarHalfAngleDeg(): number {
  return ACTIVE_SONAR_HALF_ANGLE_DEG;
}

/**
 * True when absolute bearing to a contact lies inside the forward search cone
 * about own-ship heading (± half-angle).
 */
export function isInsideActiveSonarCone(
  ownHeadingDeg: number,
  contactBearingDeg: number,
  halfAngleDeg: number = ACTIVE_SONAR_HALF_ANGLE_DEG,
): boolean {
  return Math.abs(shortestBearingDelta(ownHeadingDeg, contactBearingDeg)) <= halfAngleDeg;
}

/** True when this unit is currently emitting active-search pings. */
export function isActiveSonarPinging(
  unit: Pick<UnitState, 'activeSonarEnabled' | 'sensors' | 'condition' | 'subsystems'>,
): boolean {
  if (!unit.activeSonarEnabled) return false;
  if (!hasActiveSonarSensor(unit)) return false;
  if (unit.condition === 'sunk') return false;
  if (unit.subsystems?.sensors === 'disabled') return false;
  return true;
}
