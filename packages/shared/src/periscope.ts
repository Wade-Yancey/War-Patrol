import { PERISCOPE_MAX_RANGE_NM, RADAR_SURFACE_DEPTH_M } from './constants.js';
import { divePresetById } from './dive.js';
import { clamp } from './geo.js';
import { shortestBearingDelta } from './hydrophone.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { canUseSensors, isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Max keel depth (m) at which fleet-sub periscope optics are usable.
 * Aligns with the Periscope dive preset (18 m / ~60 ft).
 * Rule: depth ≤ this value (surfaced through periscope depth).
 */
export const PERISCOPE_DEPTH_M: number =
  divePresetById('periscope')?.depthM ?? 18;

/**
 * Base probability that a destroyer lookout notices a raised periscope
 * feather within visual range (before range falloff and exposure scale).
 */
export const PERISCOPE_SPOT_BASE_P = 0.55;

/**
 * Fraction of the turn the mast is exposed while raised (0–1).
 * Scales DD lookout feather-spot chance: brief peeks are hard to catch;
 * full-turn exposure is easier (still not guaranteed). Scope down → 0.
 */
export const PERISCOPE_EXPOSURE_MIN = 0.05;
export const PERISCOPE_EXPOSURE_MAX = 1;
/** Default when raising without an explicit exposure (full mast — old behavior). */
export const PERISCOPE_EXPOSURE_DEFAULT = 1;

/** Named peek intensities for Sensors UI / orders labels. */
export const PERISCOPE_EXPOSURE_PRESETS = [
  { id: 'peek', label: 'Peek', exposure: 0.2 },
  { id: 'brief', label: 'Brief', exposure: 0.4 },
  { id: 'half', label: 'Half', exposure: 0.65 },
  { id: 'full', label: 'Full', exposure: 1 },
] as const;

export type PeriscopeExposurePresetId =
  (typeof PERISCOPE_EXPOSURE_PRESETS)[number]['id'];

/**
 * Clamp / coerce a player exposure order to a finite 0–1 fraction.
 * Values at/below 0 → 0 (not spottable). Raised mast uses ≥ {@link PERISCOPE_EXPOSURE_MIN}.
 */
export function clampPeriscopeExposure(
  value: unknown,
  opts?: { allowZero?: boolean },
): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const lo = opts?.allowZero === false ? PERISCOPE_EXPOSURE_MIN : 0;
  return clamp(n, lo, PERISCOPE_EXPOSURE_MAX);
}

/** Effective exposure for spotting: 0 when mast is down. */
export function effectivePeriscopeExposure(
  unit: Pick<UnitState, 'type' | 'periscopeRaised' | 'periscopeExposure'>,
): number {
  if (unit.type !== 'Submarine' || !unit.periscopeRaised) return 0;
  return clampPeriscopeExposure(unit.periscopeExposure ?? PERISCOPE_EXPOSURE_DEFAULT);
}

/** Own-ship lookout / periscope set, if installed. */
export function findLookoutSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'lookout');
}

export function hasLookoutSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findLookoutSensor(unit));
}

/**
 * Whether lookout / periscope optics can form a picture.
 *
 * Surface-ship bridge lookout is **immune** to sensors-subsystem combat
 * casualties (eyeballs on the bridge stay available). Fleet-sub periscope
 * still requires the sensors subsystem intact (damageable mast / optics).
 */
export function canUseLookoutOptics(
  unit: Pick<UnitState, 'type' | 'condition' | 'subsystems'>,
): { ok: boolean; reason?: 'sunk' | 'sensors_disabled' } {
  if (unit.condition === 'sunk') return { ok: false, reason: 'sunk' };
  if (unit.type === 'Ship') return { ok: true };
  return canUseSensors(unit);
}

/**
 * Visual optics depth gate (periscope / lookout).
 * Fleet-sub periscope usable when keel depth ≤ {@link PERISCOPE_DEPTH_M};
 * deeper → unavailable (`too_deep`). Surface ships (DD lookout) always pass —
 * they don’t dive.
 */
export function isPeriscopeDepthOk(
  unit: Pick<UnitState, 'type' | 'position'>,
): { ok: boolean; reason?: 'too_deep' } {
  if (unit.type === 'Submarine' && unit.position.depth > PERISCOPE_DEPTH_M) {
    return { ok: false, reason: 'too_deep' };
  }
  return { ok: true };
}

/**
 * Targets visible as full hull silhouettes through periscope / lookout:
 * waterborne hulls that are not sunk; submerged submarines are hidden
 * (depth &gt; radar surface band). Aircraft skipped for v1.
 *
 * Raised periscope feathers on submerged boats are handled separately via
 * {@link isRaisedPeriscopeSpottable}.
 */
export function isPeriscopeTargetable(
  unit: Pick<UnitState, 'type' | 'condition' | 'position'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type === 'Aircraft') return false;
  if (unit.type === 'Submarine' && unit.position.depth > RADAR_SURFACE_DEPTH_M) {
    return false;
  }
  return true;
}

/** True when this unit is a fleet sub with the mast raised. */
export function isPeriscopeRaised(
  unit: Pick<UnitState, 'type' | 'periscopeRaised'>,
): boolean {
  return unit.type === 'Submarine' && Boolean(unit.periscopeRaised);
}

/**
 * Submerged (or awash-but-hull-hidden) boat with mast up **and** exposure &gt; 0 —
 * DD lookout may spot a periscope feather, not a full hull silhouette.
 * Scope down / zero exposure → not spottable as a feather/stick.
 */
export function isRaisedPeriscopeSpottable(
  unit: Pick<
    UnitState,
    'type' | 'condition' | 'position' | 'periscopeRaised' | 'periscopeExposure'
  >,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type !== 'Submarine') return false;
  if (!unit.periscopeRaised) return false;
  if (effectivePeriscopeExposure(unit) <= 0) return false;
  // Hull already visible as a silhouette — no separate feather contact.
  if (unit.position.depth <= RADAR_SURFACE_DEPTH_M) return false;
  // Mast only works at/above periscope depth.
  if (unit.position.depth > PERISCOPE_DEPTH_M) return false;
  return true;
}

/**
 * Chance a surface lookout notices a raised periscope at `rangeNm`.
 * Falls off toward max visual range, then scales by mast {@link exposure}
 * (0 = impossible, 1 = full base×range chance). Brief peeks are hard; long
 * time up is easier — never guaranteed (cap 0.85).
 */
export function periscopeSpotProbability(
  rangeNm: number,
  maxRangeNm: number = PERISCOPE_MAX_RANGE_NM,
  exposure: number = PERISCOPE_EXPOSURE_DEFAULT,
): number {
  const e = clampPeriscopeExposure(exposure);
  if (e <= 0 || rangeNm <= 0 || rangeNm > maxRangeNm) return 0;
  const proximity = 1 - rangeNm / maxRangeNm;
  const rangeP = PERISCOPE_SPOT_BASE_P * (0.4 + 0.6 * proximity);
  return clamp(rangeP * e, 0, 0.85);
}

/** Reset plot stamp (call whenever the scope is lowered). */
export function resetPlotStamp<T extends { plotStampTurns?: number }>(unit: T): T {
  return { ...unit, plotStampTurns: 0 };
}

/** Relative bearing deg (−180, 180] from own heading to true contact bearing. */
export function relativeBearingDeg(ownHeadingDeg: number, trueBearingDeg: number): number {
  return shortestBearingDelta(ownHeadingDeg, trueBearingDeg);
}

/** FoW coarsen relative bearing to nearest 5°. */
export function coarsenRelativeBearingDeg(relDeg: number): number {
  if (!Number.isFinite(relDeg)) return 0;
  return Math.round(relDeg / 5) * 5;
}

/** FoW coarsen range to 0.5 nm steps. */
export function coarsenPeriscopeRangeNm(rangeNm: number): number {
  if (!Number.isFinite(rangeNm) || rangeNm < 0) return 0;
  return Math.round(rangeNm * 2) / 2;
}

/** FoW coarsen absolute speed to 2 kn steps. */
export function coarsenPeriscopeSpeedKn(speedKn: number): number {
  if (!Number.isFinite(speedKn)) return 0;
  return Math.round(Math.abs(speedKn) / 2) * 2;
}

/**
 * Silhouette display scale (0.25–1) from range — farther = smaller.
 * Linear falloff vs sensor max: at 0 nm → 1, at max → 0.25.
 */
export function periscopeSilhouetteScale(
  rangeNm: number,
  maxRangeNm: number = PERISCOPE_MAX_RANGE_NM,
): number {
  const max = Math.max(1e-6, maxRangeNm);
  const t = Math.min(1, Math.max(0, rangeNm / max));
  return Math.round((1 - t * 0.75) * 100) / 100;
}

/**
 * Recognition plates under Vite `public/silhouettes/`.
 * Used for docs/verify static path checks. The Sensors UI mounts the same bytes
 * via Vite-bundled imports in `PeriscopeScope` (harder to 404 than a bare path).
 * PNGs keep alpha (`tRNS`) so plates composite over the periscope / lookout sky/sea.
 */
export const DESTROYER_SILHOUETTE_URL = '/silhouettes/destroyer.png';
export const SUBMARINE_SILHOUETTE_URL = '/silhouettes/submarine.png';

/**
 * Public asset path for a hull-class silhouette (side profile).
 * Destroyer → {@link DESTROYER_SILHOUETTE_URL};
 * Fleet Submarine → {@link SUBMARINE_SILHOUETTE_URL}.
 * Other classes → null (UI falls back to the destroyer PNG).
 */
export function silhouetteUrlForClass(
  hullClass: HullClass | string | undefined,
): string | null {
  if (!hullClass) return null;
  switch (hullClass) {
    case 'Destroyer':
      return DESTROYER_SILHOUETTE_URL;
    case 'Fleet Submarine':
      return SUBMARINE_SILHOUETTE_URL;
    default:
      return null;
  }
}

/**
 * URL to show for a selected periscope / lookout contact: class map when present,
 * otherwise the destroyer PNG so the left panel never goes blank.
 */
export function periscopeSilhouetteUrl(
  hullClass: HullClass | string | undefined,
): string {
  return silhouetteUrlForClass(hullClass) ?? DESTROYER_SILHOUETTE_URL;
}

/**
 * Default lookout / periscope install.
 * - Fleet Submarine: periscope optics (depth-gated on server)
 * - Destroyer: bridge lookout (always available when sensors live — surface ships don’t dive)
 */
export function defaultLookoutSensor(
  hullClassOrType: HullClass | string | undefined,
): SensorDef | undefined {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Fleet Submarine':
    case 'Destroyer':
      return { kind: 'lookout', maxRangeNm: PERISCOPE_MAX_RANGE_NM };
    default:
      return undefined;
  }
}

export function resolvePeriscopeMaxRangeNm(sensor: SensorDef | undefined): number {
  return sensor?.maxRangeNm ?? PERISCOPE_MAX_RANGE_NM;
}
