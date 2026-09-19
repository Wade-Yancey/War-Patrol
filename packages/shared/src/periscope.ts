import { PERISCOPE_MAX_RANGE_NM } from './constants.js';
import { divePresetById } from './dive.js';
import { shortestBearingDelta } from './hydrophone.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Max keel depth (m) at which fleet-sub periscope optics are usable.
 * Aligns with the Periscope dive preset (18 m / ~60 ft).
 * Rule: depth ≤ this value (surfaced through periscope depth).
 */
export const PERISCOPE_DEPTH_M: number =
  divePresetById('periscope')?.depthM ?? 18;

/** Own-ship lookout / periscope set, if installed. */
export function findLookoutSensor(unit: Pick<UnitState, 'sensors'>): SensorDef | undefined {
  return unit.sensors?.find((s) => s.kind === 'lookout');
}

export function hasLookoutSensor(unit: Pick<UnitState, 'sensors'>): boolean {
  return Boolean(findLookoutSensor(unit));
}

/**
 * Fleet-sub periscope usable when keel depth ≤ {@link PERISCOPE_DEPTH_M}.
 * Deeper → unavailable (`too_deep`), same CRT pattern as radar submerged.
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
 * Targets visible through the periscope stub:
 * waterborne hulls that are not sunk; submerged submarines are hidden
 * (depth &gt; radar surface band). Aircraft skipped for v1.
 */
export function isPeriscopeTargetable(
  unit: Pick<UnitState, 'type' | 'condition' | 'position'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type === 'Aircraft') return false;
  if (unit.type === 'Submarine' && unit.position.depth > 5) return false;
  return true;
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
 * Public asset path for a hull-class silhouette (side profile).
 * Destroyer → `/silhouettes/destroyer.jpg` — Wade’s raw recognition plate
 * (white plate + black line art). No PNG conversion / thresholding.
 * Other classes → null.
 */
export function silhouetteUrlForClass(
  hullClass: HullClass | string | undefined,
): string | null {
  if (!hullClass) return null;
  switch (hullClass) {
    case 'Destroyer':
      return '/silhouettes/destroyer.jpg';
    default:
      return null;
  }
}

/** Default lookout / periscope install — fleet submarines only. */
export function defaultLookoutSensor(
  hullClassOrType: HullClass | string | undefined,
): SensorDef | undefined {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });
  switch (hullClass) {
    case 'Fleet Submarine':
      return { kind: 'lookout', maxRangeNm: PERISCOPE_MAX_RANGE_NM };
    default:
      return undefined;
  }
}

export function resolvePeriscopeMaxRangeNm(sensor: SensorDef | undefined): number {
  return sensor?.maxRangeNm ?? PERISCOPE_MAX_RANGE_NM;
}
