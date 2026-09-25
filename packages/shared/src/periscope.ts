import { PERISCOPE_MAX_RANGE_NM, RADAR_SURFACE_DEPTH_M } from './constants.js';
import { divePresetById } from './dive.js';
import { clamp, normalizeHeading } from './geo.js';
import { shortestBearingDelta } from './hydrophone.js';
import type { HullClass, SensorDef, UnitState } from './types.js';
import { canUseSensorStation } from './damage.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Max keel depth (m) at which fleet-sub periscope optics are usable.
 * Aligns with the Periscope dive preset (20 m — ~60 ft rounded to coarse dial).
 * Rule: depth ≤ this value (surfaced through periscope depth).
 */
export const PERISCOPE_DEPTH_M: number =
  divePresetById('periscope')?.depthM ?? 20;

/**
 * Internal mast-up fraction (0–1). Operators do not choose this — the mast
 * is binary (raised or lowered) in real time. Raise defaults to
 * {@link PERISCOPE_EXPOSURE_DEFAULT}; lower forces 0.
 * FoW feather detection is **deterministic**: any exposure &gt; 0 while
 * raised + in lookout range paints the feather — no RNG. Scope down → 0.
 */
export const PERISCOPE_EXPOSURE_MIN = 0.05;
export const PERISCOPE_EXPOSURE_MAX = 1;
/** Default when raising without an explicit exposure (full mast). */
export const PERISCOPE_EXPOSURE_DEFAULT = 1;

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
 * Surface-ship bridge lookout is **immune** to lookout-station combat
 * casualties (eyeballs on the bridge stay available). Fleet-sub periscope
 * can be knocked out independently of radar / hydrophone.
 */
export function canUseLookoutOptics(
  unit: Pick<UnitState, 'type' | 'condition' | 'subsystems'>,
): { ok: boolean; reason?: 'sunk' | 'sensors_disabled' } {
  return canUseSensorStation(unit, 'lookout');
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
 * Targets visible as full hull / airframe silhouettes through periscope / lookout:
 * waterborne hulls and airborne aircraft that are not sunk; submerged
 * submarines are hidden (depth &gt; radar surface band). Aircraft (Fighter /
 * Bomber) are optically visible when in range — hydrophone remains blind to
 * them. Flight-level bands do not hide airframes by default.
 *
 * Raised periscope feathers on submerged boats are handled separately via
 * {@link isRaisedPeriscopeSpottable}.
 */
export function isPeriscopeTargetable(
  unit: Pick<UnitState, 'type' | 'condition' | 'position'>,
): boolean {
  if (unit.condition === 'sunk') return false;
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
 * DD lookout **always** sees a periscope feather when in visual range
 * (deterministic FoW — operators watch the screen; no spot roll).
 * Scope down / zero exposure → not visible as a feather/stick.
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

/** Reset plot stamp (call whenever the scope is lowered). */
export function resetPlotStamp<T extends { plotStampTurns?: number }>(unit: T): T {
  return { ...unit, plotStampTurns: 0 };
}

/** Relative bearing deg (−180, 180] from own heading to true contact bearing. */
export function relativeBearingDeg(ownHeadingDeg: number, trueBearingDeg: number): number {
  return shortestBearingDelta(ownHeadingDeg, trueBearingDeg);
}

/**
 * True bearing from own heading + relative (bow = 0, starboard +, port −).
 * Inverse of {@link relativeBearingDeg}. Used by the torpedo calculator so aim
 * matches optics port/stbd readouts instead of requiring a true-bearing conversion.
 */
export function trueBearingFromRelative(
  ownHeadingDeg: number,
  relativeBearingDeg: number,
): number {
  return normalizeHeading(ownHeadingDeg + relativeBearingDeg);
}

/**
 * Optics readouts are instrument-precise (ground truth) — periscope / lookout
 * glass shows the real bearing/range/course/speed, not an FoW-coarsened
 * estimate. Only display rounding is applied (nearest whole degree, 0.01 nm,
 * 0.1 kn) so numbers don't show spurious floating-point noise. Contact-N
 * anonymity (no side/class/name leak) is enforced elsewhere via `labelN` /
 * silhouette-only identity — precision here does not reveal hull identity.
 */

/** Round relative bearing to the nearest whole degree for display. */
export function coarsenRelativeBearingDeg(relDeg: number): number {
  if (!Number.isFinite(relDeg)) return 0;
  return Math.round(relDeg);
}

/** Round range to the nearest 0.01 nm for display. */
export function coarsenPeriscopeRangeNm(rangeNm: number): number {
  if (!Number.isFinite(rangeNm) || rangeNm < 0) return 0;
  return Math.round(rangeNm * 100) / 100;
}

/** Round absolute speed to the nearest 0.1 kn for display. */
export function coarsenPeriscopeSpeedKn(speedKn: number): number {
  if (!Number.isFinite(speedKn)) return 0;
  return Math.round(Math.abs(speedKn) * 10) / 10;
}

/**
 * Precise true course read straight off the observed hull, rounded to the
 * nearest whole degree ([0, 360)) for display. Ground truth, not a coarse
 * visual estimate. Feathers omit course (stick gives no aspect).
 */
export function coarsenPeriscopeCourseDeg(headingDeg: number): number {
  if (!Number.isFinite(headingDeg)) return 0;
  return normalizeHeading(Math.round(normalizeHeading(headingDeg)));
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
 * Whether to mirror a bow-right recognition plate for the observed aspect.
 *
 * **Flip rule (periscope / lookout hull plates):**
 * - Asset plates are drawn **bow right** (starboard-side elevation).
 * - Signed angle-on-bow (AOB) = shortest turn from FoW `courseDeg` to the
 *   bearing from the target back to the observer (`trueBearing + 180°`),
 *   where `trueBearing = ownHeading + relativeBearing`.
 * - `aob < 0` → **port aspect** → flip horizontally (`scaleX(-1)`, bow left).
 * - `aob ≥ 0` → **starboard / end-on** → leave unflipped (bow right).
 * - Missing / non-finite `courseDeg` (e.g. periscope feathers) → no flip.
 */
export function periscopeSilhouetteFlipX(
  ownHeadingDeg: number,
  relativeBearingDeg: number,
  courseDeg: number | undefined,
): boolean {
  if (courseDeg == null || !Number.isFinite(courseDeg)) return false;
  if (!Number.isFinite(ownHeadingDeg) || !Number.isFinite(relativeBearingDeg)) {
    return false;
  }
  const trueBearing = trueBearingFromRelative(ownHeadingDeg, relativeBearingDeg);
  const bearingFromTargetToObserver = normalizeHeading(trueBearing + 180);
  const aob = shortestBearingDelta(courseDeg, bearingFromTargetToObserver);
  return aob < 0;
}

/**
 * Recognition plates under Vite `public/silhouettes/`.
 * Used for docs/verify static path checks. The Sensors UI mounts the same bytes
 * via Vite-bundled imports in `PeriscopeScope` (harder to 404 than a bare path).
 * PNGs keep alpha (`tRNS`) so plates composite over the periscope / lookout sky/sea.
 */
export const DESTROYER_SILHOUETTE_URL = '/silhouettes/destroyer.png';
export const SUBMARINE_SILHOUETTE_URL = '/silhouettes/submarine.png';
export const OILER_SILHOUETTE_URL = '/silhouettes/oiler.png';
export const CARRIER_SILHOUETTE_URL = '/silhouettes/carrier.png';
/** Kagerō-class IJN destroyer plate (distinct from US Fletcher `destroyer.png`). */
export const KAGERO_SILHOUETTE_URL = '/silhouettes/kagero.png';
/** Mitsubishi A6M Zeke recognition plate (distinct from generic Fighter fallback). */
export const ZEKE_SILHOUETTE_URL = '/silhouettes/zeke.png';

/**
 * Class-specific optics plate stem when multiple library hulls share a taxonomic
 * class (Kagerō vs Fletcher both `Destroyer`; Zeke vs Hellcat both `Fighter`).
 * Matches `/silhouettes/<plate>.png`.
 */
export function silhouettePlateForClassId(
  classId: string | undefined,
): string | undefined {
  const id = typeof classId === 'string' ? classId.toLowerCase() : '';
  if (id.includes('kagero') || id.includes('kagerō')) return 'kagero';
  if (id.includes('zeke') || id.includes('a6m')) return 'zeke';
  return undefined;
}

/**
 * Public asset path for a class-specific plate stem (e.g. `"kagero"`).
 * Unknown plates → null (caller falls back to taxonomic class map).
 */
export function silhouetteUrlForPlate(plate: string | undefined): string | null {
  if (!plate) return null;
  switch (plate) {
    case 'kagero':
      return KAGERO_SILHOUETTE_URL;
    case 'zeke':
      return ZEKE_SILHOUETTE_URL;
    default:
      return null;
  }
}

/**
 * Public asset path for a hull-class silhouette (side profile / recognition plate).
 * Destroyer → {@link DESTROYER_SILHOUETTE_URL} (Fletcher default);
 * Fleet Submarine → {@link SUBMARINE_SILHOUETTE_URL};
 * Oiler → {@link OILER_SILHOUETTE_URL} (Cimarron-class plate);
 * Aircraft Carrier → {@link CARRIER_SILHOUETTE_URL} (Shōkaku-class plate);
 * Fighter / Bomber → null until a plate stem is selected (Zeke via classId).
 * Other classes → null (UI falls back to the destroyer PNG).
 * Prefer {@link silhouetteUrlForOptics} when `classId` / plate may select Kagerō / Zeke art.
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
    case 'Oiler':
      return OILER_SILHOUETTE_URL;
    case 'Aircraft Carrier':
      return CARRIER_SILHOUETTE_URL;
    default:
      return null;
  }
}

/**
 * Optics plate URL: class-specific plate (Kagerō / Zeke) wins over taxonomic class map.
 */
export function silhouetteUrlForOptics(opts: {
  hullClass?: HullClass | string;
  classId?: string;
  silhouettePlate?: string;
}): string | null {
  const plate =
    opts.silhouettePlate ?? silhouettePlateForClassId(opts.classId) ?? undefined;
  return silhouetteUrlForPlate(plate) ?? silhouetteUrlForClass(opts.hullClass);
}

/**
 * URL to show for a selected periscope / lookout contact: class map when present,
 * otherwise the destroyer PNG so the left panel never goes blank.
 */
export function periscopeSilhouetteUrl(
  hullClass: HullClass | string | undefined,
  opts?: { classId?: string; silhouettePlate?: string },
): string {
  return (
    silhouetteUrlForOptics({
      hullClass,
      classId: opts?.classId,
      silhouettePlate: opts?.silhouettePlate,
    }) ?? DESTROYER_SILHOUETTE_URL
  );
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
