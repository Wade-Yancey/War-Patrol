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
