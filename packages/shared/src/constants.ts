/** Schema version for Scenario and Save documents (ARCH-SM-03/08). */
export const SCHEMA_VERSION = 1 as const;

/** Default wall-clock seconds for an ordering phase. */
export const DEFAULT_TURN_SECONDS = 180;

/** Approximate meters per degree latitude (equirectangular). */
export const METERS_PER_DEG_LAT = 111_320;

/** Knots → meters per second. */
export const KNOTS_TO_MPS = 0.514444;

/** Simulated seconds represented by one resolved turn (movement stub). */
export const TURN_DURATION_SECONDS = 360;

/** Meters in one nautical mile. */
export const METERS_PER_NM = 1852;

/** Stub surface-search radar max range (nm) for destroyer-class demos. */
export const RADAR_MAX_RANGE_NM = 25;

/**
 * Depth (m) at/above which a unit is treated as surfaced for radar:
 * own-ship PPI usable, and target returns an echo.
 */
export const RADAR_SURFACE_DEPTH_M = 5;

/** Detection range multiplier by radar signature size. */
export const RADAR_SIGNATURE_RANGE_FACTOR = {
  small: 0.7,
  medium: 1,
  large: 1.15,
} as const;

/** Echo strength bias by radar signature (added into range falloff). */
export const RADAR_SIGNATURE_STRENGTH = {
  small: 0.55,
  medium: 0.85,
  large: 1,
} as const;
