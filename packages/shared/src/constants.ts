/** Schema version for Scenario and Save documents (ARCH-SM-03/08). */
export const SCHEMA_VERSION = 1 as const;

/** Default wall-clock seconds for an ordering phase (5 min — live-action pace). */
export const DEFAULT_TURN_SECONDS = 300;

/** Umpire order-timer touch step (30 seconds). */
export const TIMER_STEP_SECONDS = 30;

/** Default umpire “extend timer” amount (1 minute). */
export const TIMER_EXTEND_SECONDS = 60;

/**
 * Default in-game seconds advanced per resolved turn (Wade: 5 min for we-go ASW).
 * Scenario-configurable via `turnLengthSeconds`.
 */
export const DEFAULT_TURN_LENGTH_SECONDS = 300;

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
