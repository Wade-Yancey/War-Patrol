import {
  HYDROPHONE_BEAM_POWER,
  HYDROPHONE_MAX_RANGE_NM,
  HYDROPHONE_RANGE_REF_NM,
  HYDROPHONE_UNDERWAY_SPEED_KN,
} from './constants.js';
import { normalizeHeading } from './geo.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Own-ship hydrophone set, if installed. */
export function findHydrophoneSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'hydrophone');
}

export function hasHydrophoneSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findHydrophoneSensor(unit));
}

/**
 * Hulls that emit underwater propeller noise when underway.
 * Aircraft are skipped (airborne — not a waterborne contact for v1 hydrophone).
 */
export function isHydrophoneEmitter(
  unit: Pick<UnitState, 'type' | 'condition' | 'speed'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type === 'Aircraft') return false;
  return Math.abs(unit.speed) >= HYDROPHONE_UNDERWAY_SPEED_KN;
}

/** Shortest signed angle delta in degrees (−180, 180]. */
export function shortestBearingDelta(fromDeg: number, toDeg: number): number {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

/**
 * Range attenuation (0–1): inverse-square-ish soft falloff.
 * `1 / (1 + (r / R0)²)` with R0 = {@link HYDROPHONE_RANGE_REF_NM}.
 */
export function hydrophoneRangeGain(
  rangeNm: number,
  refNm: number = HYDROPHONE_RANGE_REF_NM,
): number {
  if (rangeNm <= 0) return 1;
  const x = rangeNm / Math.max(1e-6, refNm);
  return 1 / (1 + x * x);
}

/**
 * Directional beam gain (0–1) for listen needle vs contact true bearing.
 * Peaked cosine lobe: `max(0, cos(Δ))^power` — silent in the rear half-plane.
 */
export function hydrophoneBeamGain(
  listenBearingDeg: number,
  contactBearingDeg: number,
  power: number = HYDROPHONE_BEAM_POWER,
): number {
  const deltaRad =
    (shortestBearingDelta(listenBearingDeg, contactBearingDeg) * Math.PI) / 180;
  const cos = Math.cos(deltaRad);
  if (cos <= 0) return 0;
  return cos ** power;
}

/** Combined per-contact gain for Web Audio mixing. */
export function hydrophoneContactGain(
  rangeNm: number,
  listenBearingDeg: number,
  contactBearingDeg: number,
): number {
  return (
    hydrophoneRangeGain(rangeNm) *
    hydrophoneBeamGain(listenBearingDeg, contactBearingDeg)
  );
}

/** Default hydrophone install for a hull class (alongside radar where applicable). */
export function defaultHydrophoneSensor(
  hullClassOrType: HullClass | string | undefined,
): SensorDef | undefined {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Destroyer':
    case 'Cruiser':
    case 'Battleship':
    case 'Aircraft Carrier':
    case 'Fleet Submarine':
      return { kind: 'hydrophone', maxRangeNm: HYDROPHONE_MAX_RANGE_NM };
    default:
      return undefined;
  }
}

export function resolveHydrophoneMaxRangeNm(sensor: SensorDef | undefined): number {
  return sensor?.maxRangeNm ?? HYDROPHONE_MAX_RANGE_NM;
}

export function normalizeListenBearing(deg: number): number {
  return normalizeHeading(deg);
}
