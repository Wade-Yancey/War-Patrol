import {
  ACTIVE_SONAR_HALF_ANGLE_DEG,
  ACTIVE_SONAR_MAX_RANGE_NM,
  RADAR_SURFACE_DEPTH_M,
  SUBMARINE_MAX_DEPTH_M,
} from './constants.js';
import { clamp } from './geo.js';
import { formatDepthMeters } from './orders.js';
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
  if (unit.subsystems?.activeSonar === 'disabled') return false;
  return true;
}

/**
 * Precise keel-depth readout for an active-sonar echo (meters, positive
 * down) — ground truth, rounded to the nearest whole meter for display.
 * Surface band (≤ {@link RADAR_SURFACE_DEPTH_M}) → 0 (surfaced, no keel
 * depth to report). Active sonar is 100% accurate, same as radar; the only
 * "fog" here is the surfaced/submerged gate, not the depth number itself.
 * Operators set depth-charge rack depth from this readout.
 */
export function coarsenActiveSonarDepthM(depthM: number): number {
  if (!Number.isFinite(depthM) || depthM <= RADAR_SURFACE_DEPTH_M) return 0;
  return Math.round(clamp(depthM, 0, SUBMARINE_MAX_DEPTH_M));
}

/** CRT string for sonar estimated depth (e.g. `EST 050 m`). */
export function formatActiveSonarEstimatedDepth(depthM: number): string {
  return `EST ${formatDepthMeters(coarsenActiveSonarDepthM(depthM))}`;
}
