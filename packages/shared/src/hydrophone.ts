import {
  HYDROPHONE_BEAM_POWER,
  HYDROPHONE_DEPTH_ATTEN_REF_M,
  HYDROPHONE_LISTEN_QUALITY_FLOOR,
  HYDROPHONE_MAX_RANGE_NM,
  HYDROPHONE_RADIATED_CREEP_LEVEL,
  HYDROPHONE_RANGE_REF_NM,
  HYDROPHONE_SELF_NOISE_FLANK,
  HYDROPHONE_SELF_NOISE_POWER,
  HYDROPHONE_UNDERWAY_SPEED_KN,
  RADAR_SURFACE_DEPTH_M,
} from './constants.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { effectiveMaxSpeed } from './performance.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Own-ship hydrophone set, if installed. */
export function findHydrophoneSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'hydrophone');
}

export function hasHydrophoneSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findHydrophoneSensor(unit));
}

/**
 * Fleet-sub hydrophone is submerged-only (depth > surface band).
 * Surface ships with a hydrophone (destroyers) are not depth-gated.
 */
export function isHydrophoneDepthOk(
  unit: Pick<UnitState, 'type' | 'position'>,
): { ok: boolean; reason?: 'surfaced' } {
  if (unit.type === 'Submarine' && unit.position.depth <= RADAR_SURFACE_DEPTH_M) {
    return { ok: false, reason: 'surfaced' };
  }
  return { ok: true };
}

/**
 * Hulls that emit underwater propeller / screw noise.
 * Aircraft skipped. EOT `stop` muffles screws even while coasting on residual way.
 * Otherwise requires `|speed| ≥ HYDROPHONE_UNDERWAY_SPEED_KN`.
 */
export function isHydrophoneEmitter(
  unit: Pick<UnitState, 'type' | 'condition' | 'speed' | 'eot'>,
): boolean {
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return false;
  if (unit.type === 'Aircraft') return false;
  // Engines answering STOP → screws silent (glide without prop wash).
  if (unit.eot === 'stop') return false;
  return Math.abs(unit.speed) >= HYDROPHONE_UNDERWAY_SPEED_KN;
}

/**
 * Effective speed ceiling used to normalize radiated / self-noise fractions.
 * Subs use submerged cap when deeper than the surface band.
 */
export function hydrophoneSpeedCeilingKn(
  unit: Pick<UnitState, 'type' | 'position' | 'maxSpeed'>,
): number {
  return Math.max(
    1e-6,
    effectiveMaxSpeed({
      type: unit.type,
      maxSpeed: unit.maxSpeed,
      depth: unit.position.depth,
    }),
  );
}

/** Clamp speed / ceiling → [0, 1]. */
export function hydrophoneSpeedFraction(speedKn: number, ceilingKn: number): number {
  const ceil = Math.max(1e-6, Math.abs(ceilingKn));
  return Math.min(1, Math.max(0, Math.abs(speedKn) / ceil));
}

/**
 * Depth coupling for radiated noise (0–1). Surface → 1.
 * `1 / (1 + depthM / REF)` — deeper keel quieter to listeners (layer-free stub).
 */
export function hydrophoneDepthRadiatedGain(
  depthM: number,
  refM: number = HYDROPHONE_DEPTH_ATTEN_REF_M,
): number {
  if (!Number.isFinite(depthM) || depthM <= 0) return 1;
  return 1 / (1 + depthM / Math.max(1e-6, refM));
}

/**
 * Radiated screw source level (0–1+) from emitter speed + depth.
 * Creep (~15% ceiling) ≈ {@link HYDROPHONE_RADIATED_CREEP_LEVEL}; flank → ~1.
 * Power curve between creep and flank; depth attenuates submerged emitters.
 * Returns 0 when not an emitter (caller should still gate with {@link isHydrophoneEmitter}).
 */
export function hydrophoneRadiatedSourceLevel(
  unit: Pick<UnitState, 'type' | 'condition' | 'speed' | 'eot' | 'position' | 'maxSpeed'>,
): number {
  if (!isHydrophoneEmitter(unit)) return 0;
  const frac = hydrophoneSpeedFraction(unit.speed, hydrophoneSpeedCeilingKn(unit));
  // Map 0→creep level at low speed, 1→1.0 at flank (smooth power).
  // At frac=0.15 (ahead_1-ish): ≈ creep level.
  const creepFrac = 0.15;
  let level: number;
  if (frac <= creepFrac) {
    level = HYDROPHONE_RADIATED_CREEP_LEVEL * (frac / creepFrac);
  } else {
    const t = (frac - creepFrac) / (1 - creepFrac);
    level =
      HYDROPHONE_RADIATED_CREEP_LEVEL +
      (1 - HYDROPHONE_RADIATED_CREEP_LEVEL) * t ** 1.25;
  }
  // Fleet boats are a bit quieter than surface combatants at the same fraction.
  if (unit.type === 'Submarine') {
    level *= 0.85;
  }
  level *= hydrophoneDepthRadiatedGain(unit.position.depth);
  return Math.min(1.25, Math.max(0, level));
}

/**
 * Own-ship self-noise (0–1) from speed. Stop / crawl → ~0; flank →
 * {@link HYDROPHONE_SELF_NOISE_FLANK}.
 */
export function hydrophoneSelfNoise(
  unit: Pick<UnitState, 'type' | 'speed' | 'eot' | 'position' | 'maxSpeed' | 'condition'>,
): number {
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return 0;
  // Engines stopped → quiet platform (best listen).
  if (unit.eot === 'stop' || Math.abs(unit.speed) < HYDROPHONE_UNDERWAY_SPEED_KN) {
    return 0;
  }
  const frac = hydrophoneSpeedFraction(unit.speed, hydrophoneSpeedCeilingKn(unit));
  return Math.min(
    1,
    HYDROPHONE_SELF_NOISE_FLANK * frac ** HYDROPHONE_SELF_NOISE_POWER,
  );
}

/**
 * Listen quality (0–1) after own self-noise. Multiplies contact gains and
 * effective hearing range. Floor keeps flank from being fully deaf.
 */
export function hydrophoneListenQuality(
  unit: Pick<UnitState, 'type' | 'speed' | 'eot' | 'position' | 'maxSpeed' | 'condition'>,
): number {
  const noise = hydrophoneSelfNoise(unit);
  return Math.max(HYDROPHONE_LISTEN_QUALITY_FLOOR, 1 - noise);
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
  sourceLevel: number = 1,
  listenQuality: number = 1,
): number {
  const level = Number.isFinite(sourceLevel) ? Math.max(0, sourceLevel) : 1;
  const quality = Number.isFinite(listenQuality) ? Math.max(0, Math.min(1, listenQuality)) : 1;
  return Math.min(
    1,
    hydrophoneRangeGain(rangeNm) *
      hydrophoneBeamGain(listenBearingDeg, contactBearingDeg) *
      level *
      quality,
  );
}

/**
 * Coarse range band for operator CRT (secondary to approx nm).
 * Thresholds relative to {@link HYDROPHONE_RANGE_REF_NM} (8 nm ≈ half-gain):
 * Near ≤ 5 nm, Medium ≤ 12 nm, else Far (still within hearing).
 */
export type HydrophoneRangeBand = 'near' | 'medium' | 'far' | 'none';

export const HYDROPHONE_RANGE_BAND_NEAR_NM = 5;
export const HYDROPHONE_RANGE_BAND_MEDIUM_NM = 12;

/** Minimum beam gain before range approx / band is shown (needle roughly on target). */
export const HYDROPHONE_RANGE_BAND_BEAM_MIN = 0.2;

export function hydrophoneRangeBandFromRangeNm(rangeNm: number): HydrophoneRangeBand {
  if (!Number.isFinite(rangeNm) || rangeNm < 0) return 'none';
  if (rangeNm <= HYDROPHONE_RANGE_BAND_NEAR_NM) return 'near';
  if (rangeNm <= HYDROPHONE_RANGE_BAND_MEDIUM_NM) return 'medium';
  return 'far';
}

/**
 * Invert range falloff to a FoW-friendly approximate range (nm).
 * `rangeGain = 1 / (1 + (r/R0)²)` → `r = R0 × √(1/g − 1)`.
 * Coarsened: 1 nm steps below 10 nm, 2 nm steps at/above — never a precise float.
 */
export function approximateRangeNmFromRangeGain(
  rangeGain: number,
  refNm: number = HYDROPHONE_RANGE_REF_NM,
): number | null {
  if (!Number.isFinite(rangeGain) || rangeGain <= 0.02) return null;
  if (rangeGain >= 0.999) return 0;
  const r = refNm * Math.sqrt(1 / rangeGain - 1);
  if (!Number.isFinite(r) || r < 0) return null;
  if (r < 10) return Math.max(0, Math.round(r));
  return Math.round(r / 2) * 2;
}

/**
 * Peak contact on the listen bearing → intensity + approx nm + coarse band.
 * Approx nm inverts range falloff of the loudest contact when beam is aligned;
 * otherwise approx/band are withheld so beam loss does not look like distance.
 */
export function hydrophoneListenCue(
  contacts: ReadonlyArray<{ rangeNm: number; bearing: number; sourceLevel?: number }>,
  listenBearingDeg: number,
  listenQuality: number = 1,
): {
  intensity: number;
  rangeBand: HydrophoneRangeBand;
  peakRangeNm: number | null;
  approxRangeNm: number | null;
} {
  if (contacts.length === 0) {
    return { intensity: 0, rangeBand: 'none', peakRangeNm: null, approxRangeNm: null };
  }
  const quality = Number.isFinite(listenQuality) ? Math.max(0, Math.min(1, listenQuality)) : 1;
  let bestGain = 0;
  let bestBeam = 0;
  let bestRange: number | null = null;
  for (const c of contacts) {
    const beam = hydrophoneBeamGain(listenBearingDeg, c.bearing);
    const level = Number.isFinite(c.sourceLevel) ? Math.max(0, c.sourceLevel ?? 1) : 1;
    const gain = Math.min(1, hydrophoneRangeGain(c.rangeNm) * beam * level * quality);
    if (gain > bestGain) {
      bestGain = gain;
      bestBeam = beam;
      bestRange = c.rangeNm;
    }
  }
  const aligned = bestBeam >= HYDROPHONE_RANGE_BAND_BEAM_MIN && bestRange != null;
  // Prefer rangeGain of peak contact (intensity/beam/quality) so beam attenuation
  // is not double-counted as distance; coarsen for FoW.
  const rangeGainOnly =
    aligned && bestBeam > 0 && quality > 0
      ? Math.min(1, bestGain / (bestBeam * quality))
      : 0;
  const approxRangeNm = aligned
    ? approximateRangeNmFromRangeGain(rangeGainOnly)
    : null;
  const rangeBand =
    aligned && bestRange != null ? hydrophoneRangeBandFromRangeNm(bestRange) : 'none';
  return { intensity: bestGain, rangeBand, peakRangeNm: bestRange, approxRangeNm };
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

/**
 * Default hydrophone install — fleet submarines + destroyers
 * (DD passive listen alongside active search sonar).
 */
export function defaultHydrophoneSensor(
  hullClassOrType: HullClass | string | undefined,
): SensorDef | undefined {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Fleet Submarine':
    case 'Destroyer':
      return { kind: 'hydrophone', maxRangeNm: HYDROPHONE_MAX_RANGE_NM };
    default:
      return undefined;
  }
}

export function resolveHydrophoneMaxRangeNm(sensor: SensorDef | undefined): number {
  return sensor?.maxRangeNm ?? HYDROPHONE_MAX_RANGE_NM;
}

/** Effective hearing range after own-ship self-noise (nm). */
export function hydrophoneEffectiveMaxRangeNm(
  configuredMaxNm: number,
  listenQuality: number,
): number {
  const q = Number.isFinite(listenQuality) ? Math.max(0, Math.min(1, listenQuality)) : 1;
  return Math.max(0, configuredMaxNm * q);
}

/** True when a reload acoustic cue stamped on `turnNumber` is still hearable. */
export function isHydrophoneReloadCueLive(
  cueTurn: number | undefined,
  currentTurn: number,
): boolean {
  if (cueTurn == null || !Number.isFinite(cueTurn)) return false;
  // Hearable on the turn it started and through the following turn (spike linger).
  return cueTurn === currentTurn || cueTurn === currentTurn - 1;
}
