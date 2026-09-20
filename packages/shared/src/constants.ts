/** Schema version for Scenario and Save documents (ARCH-SM-03/08). */
export const SCHEMA_VERSION = 1 as const;

/** Default wall-clock seconds for an ordering phase (3 min — live-action pace). */
export const DEFAULT_TURN_SECONDS = 180;

/** Umpire order-timer touch step (30 seconds). */
export const TIMER_STEP_SECONDS = 30;

/** Default umpire “extend timer” amount (1 minute). */
export const TIMER_EXTEND_SECONDS = 60;

/**
 * Default in-game seconds advanced per resolved turn (Wade: 3 min for we-go ASW).
 * Scenario-configurable via `turnLengthSeconds`.
 */
export const DEFAULT_TURN_LENGTH_SECONDS = 180;

/**
 * Default scenario clock at turn 1 (seconds since midnight) — 08:00 local.
 * Scenario-configurable via `startGameTimeSeconds`.
 */
export const DEFAULT_START_GAME_TIME_SECONDS = 8 * 3600;

/** Approximate meters per degree latitude (equirectangular). */
export const METERS_PER_DEG_LAT = 111_320;

/** Knots → meters per second. */
export const KNOTS_TO_MPS = 0.514444;

/**
 * @deprecated Prefer scenario/save `turnLengthSeconds` (default {@link DEFAULT_TURN_LENGTH_SECONDS}).
 * Kept as alias so older imports still compile during migration.
 */
export const TURN_DURATION_SECONDS = DEFAULT_TURN_LENGTH_SECONDS;

/**
 * Steady-turn rate (degrees per in-game minute) by radar signature / hull size.
 * Larger ships turn slower. Used when unit/class omit an explicit turnRate.
 */
export const TURN_RATE_DEG_PER_MIN = {
  small: 12,
  medium: 7,
  large: 4,
} as const;

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

/**
 * Passive hydrophone max hearing range (nm).
 * Slightly beyond stub radar so operators can hear contacts that are not yet painted.
 */
export const HYDROPHONE_MAX_RANGE_NM = 30;

/**
 * Range reference (nm) for hydrophone inverse-square-ish falloff:
 * `rangeGain = 1 / (1 + (rangeNm / HYDROPHONE_RANGE_REF_NM)^2)`.
 * At ref distance gain ≈ 0.5.
 */
export const HYDROPHONE_RANGE_REF_NM = 8;

/**
 * Beam lobe sharpness for listen bearing: `beamGain = max(0, cos(Δ))^power`.
 * Higher = narrower peak toward the contact.
 */
export const HYDROPHONE_BEAM_POWER = 4;

/** Absolute speed (kn) at/above which a hull is treated as underway (emits propeller noise). */
export const HYDROPHONE_UNDERWAY_SPEED_KN = 0.1;

/**
 * Destroyer active search sonar stub max range (nm).
 * Shorter than surface-search radar — forward cone only.
 */
export const ACTIVE_SONAR_MAX_RANGE_NM = 8;

/**
 * Half-angle (degrees) of the active-search forward cone about own heading.
 * Full cone width = 2 × this value (stub: ±30°).
 */
export const ACTIVE_SONAR_HALF_ANGLE_DEG = 30;

/**
 * Wall-clock seconds between active-sonar pings (own set + hydrophone hear).
 * Stub cadence ~ASDIC search (was 2 s — too rapid for a believable ping cycle).
 */
export const ACTIVE_SONAR_PING_INTERVAL_SEC = 6;

/**
 * Periscope / lookout visual max range (nm) — short stub.
 * Shared by fleet-sub periscope and destroyer bridge lookout.
 * Silhouettes only; farther contacts shrink on the CRT.
 */
export const PERISCOPE_MAX_RANGE_NM = 6;

/**
 * Max ordered / actual depth (m) for fleet submarines in v1.
 * Slightly past Gato test depth (~300 ft / 91 m); crush depth is not modeled.
 */
export const SUBMARINE_MAX_DEPTH_M = 100;
