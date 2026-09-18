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

/**
 * Coarse range band for operator CRT (no precise nm spoiler).
 * Thresholds relative to {@link HYDROPHONE_RANGE_REF_NM} (8 nm ≈ half-gain):
 * Near ≤ 5 nm, Medium ≤ 12 nm, else Far (still within hearing).
 */
export type HydrophoneRangeBand = 'near' | 'medium' | 'far' | 'none';

export const HYDROPHONE_RANGE_BAND_NEAR_NM = 5;
export const HYDROPHONE_RANGE_BAND_MEDIUM_NM = 12;

/** Minimum beam gain before a range band is shown (needle must be roughly on target). */
export const HYDROPHONE_RANGE_BAND_BEAM_MIN = 0.2;

export function hydrophoneRangeBandFromRangeNm(rangeNm: number): HydrophoneRangeBand {
  if (!Number.isFinite(rangeNm) || rangeNm < 0) return 'none';
  if (rangeNm <= HYDROPHONE_RANGE_BAND_NEAR_NM) return 'near';
  if (rangeNm <= HYDROPHONE_RANGE_BAND_MEDIUM_NM) return 'medium';
  return 'far';
}

/**
 * Peak contact on the listen bearing → intensity + coarse range band.
 * Band uses true range of the loudest contact only when beam is aligned enough;
 * otherwise band is `none` (sweep) so misalignment does not look like "far".
 */
export function hydrophoneListenCue(
  contacts: ReadonlyArray<{ rangeNm: number; bearing: number }>,
  listenBearingDeg: number,
): { intensity: number; rangeBand: HydrophoneRangeBand; peakRangeNm: number | null } {
  if (contacts.length === 0) {
    return { intensity: 0, rangeBand: 'none', peakRangeNm: null };
  }
  let bestGain = 0;
  let bestBeam = 0;
  let bestRange: number | null = null;
  for (const c of contacts) {
    const beam = hydrophoneBeamGain(listenBearingDeg, c.bearing);
    const gain = hydrophoneRangeGain(c.rangeNm) * beam;
    if (gain > bestGain) {
      bestGain = gain;
      bestBeam = beam;
      bestRange = c.rangeNm;
    }
  }
  const rangeBand =
    bestBeam >= HYDROPHONE_RANGE_BAND_BEAM_MIN && bestRange != null
      ? hydrophoneRangeBandFromRangeNm(bestRange)
      : 'none';
  return { intensity: bestGain, rangeBand, peakRangeNm: bestRange };
}

/**
 * Stable per-contact voice coloring so multiple propellers do not stack identically.
 * Returns playbackRate (~0.92–1.08) and loop start fraction (0–1 of buffer length).
 */
export function hydrophoneContactVoiceOffset(contactId: string): {
  playbackRate: number;
  loopStartFraction: number;
} {
  let h = 2166136261;
  for (let i = 0; i < contactId.length; i++) {
    h ^= contactId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  const playbackRate = 0.92 + ((u % 17) / 16) * 0.16;
  const loopStartFraction = (u % 1000) / 1000;
  return { playbackRate, loopStartFraction };
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
