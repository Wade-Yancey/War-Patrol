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
 * Steady-turn rate (degrees per in-game minute) by radar signature band.
 * Legacy 3-band fallback (small/medium/large), kept for hull classes that
 * have no explicit per-class entry in {@link TURN_RATE_DEG_PER_MIN_BY_CLASS}
 * (e.g. Fighter/Bomber). Radar signature is a radar-cross-section proxy, not
 * a maneuverability proxy — most ship classes should use the per-class table
 * instead, since e.g. a destroyer and an oiler can share a "medium" radar
 * signature while having very different turning agility.
 */
export const TURN_RATE_DEG_PER_MIN = {
  small: 12,
  medium: 7,
  large: 4,
} as const;

/**
 * Steady-turn rate (degrees per in-game minute) by hull class — the source of
 * truth for ship/sub turning agility. Historically-plausible ordering:
 * destroyers are the snappiest surface combatants; fleet submarines sit
 * between destroyers and capital ships; large auxiliaries (oilers, merchant
 * hulls) and capital ships (cruisers/battleships/carriers) are sluggish.
 * Classes omitted here (Fighter, Bomber) fall back to their radarSignature
 * band in {@link TURN_RATE_DEG_PER_MIN}.
 */
export const TURN_RATE_DEG_PER_MIN_BY_CLASS = {
  Destroyer: 7,
  'Fleet Submarine': 6,
  Cruiser: 4,
  'Aircraft Carrier': 4,
  Battleship: 4,
  Oiler: 4,
  Merchant: 3,
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

/**
 * Absolute speed (kn) at/above which a hull with engines answering is treated
 * as underway for screw noise. Combined with EOT `stop` (screws silent even
 * while coasting) in {@link isHydrophoneEmitter}.
 */
export const HYDROPHONE_UNDERWAY_SPEED_KN = 0.1;

/**
 * Radiated propeller source level at creep (~15% of effective max speed).
 * Flank approaches 1.0; stop / not-underway → 0 (no contact).
 */
export const HYDROPHONE_RADIATED_CREEP_LEVEL = 0.35;

/**
 * Depth (m) reference for submarine radiated-noise attenuation:
 * `depthGain = 1 / (1 + depthM / HYDROPHONE_DEPTH_ATTEN_REF_M)`.
 * At 60 m ≈ 0.5 vs a shallow emitter; surface ships (depth 0) → 1.
 * Layer-free stub — not a full thermocline model.
 */
export const HYDROPHONE_DEPTH_ATTEN_REF_M = 60;

/**
 * Own-ship self-noise at flank (speed fraction 1.0). Listen quality =
 * `1 − HYDROPHONE_SELF_NOISE_FLANK × speedFrac^power` (creep near-silent self-noise).
 */
export const HYDROPHONE_SELF_NOISE_FLANK = 0.75;

/** Exponent on own speed fraction for self-noise (higher → creep stays quieter longer). */
export const HYDROPHONE_SELF_NOISE_POWER = 1.35;

/**
 * Floor on listen quality after self-noise (never fully deaf at flank —
 * very close loud contacts can still spike through).
 */
export const HYDROPHONE_LISTEN_QUALITY_FLOOR = 0.22;

/**
 * Relative source loudness of a torpedo-room reload clank (one-shot hydro cue).
 * FoW-safe intensity only — no room / GT identity.
 */
export const HYDROPHONE_RELOAD_SOURCE_LEVEL = 1.4;

/**
 * Max range (nm) at which a torpedo reload acoustic cue is hearable
 * (shorter than continuous propeller max — mechanical spike, not screws).
 */
export const HYDROPHONE_RELOAD_RANGE_NM = 8;

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
 * Wall-clock seconds between active-sonar pings (own Sensors set + faint DD
 * Controls own-ship ambience + hydrophone hear + close-aboard sub Controls
 * hull hear).
 * Stub cadence ~ASDIC search (was 2 s — too rapid for a believable ping cycle).
 */
export const ACTIVE_SONAR_PING_INTERVAL_SEC = 6;

/**
 * Max range (nm) at which another vessel’s active search sonar is audible on
 * submerged submarine Controls (hull-coupled through the water — very close
 * only; hydrophone remains the long-range listen path).
 */
export const ACTIVE_SONAR_CONTROLS_AUDIBLE_NM = 0.8;

/**
 * Periscope / lookout visual max range (nm) — short stub.
 * Shared by fleet-sub periscope and destroyer bridge lookout.
 * Silhouettes only; farther contacts shrink on the CRT.
 */
export const PERISCOPE_MAX_RANGE_NM = 6;

/**
 * Coarse dive-order increment (m) for fleet submarines.
 * Players order in large steps so patrol / test / crush lines are deliberate
 * decision points — not silent 1 m GT dialing.
 */
export const SUBMARINE_DEPTH_ORDER_STEP_M = 10;

/**
 * Gato / fleet-boat depth bands (meters, positive-down). Historically plausible
 * WWII approximations, snapped to {@link SUBMARINE_DEPTH_ORDER_STEP_M}:
 * - Patrol ~164 ft — normal submerged operating / “safe” ordered band
 * - Test ~295 ft — design test depth (~300 ft)
 * - Crush ~492 ft — estimated collapse depth (~500 ft)
 */
export const FLEET_SUB_PATROL_DEPTH_M = 50;
export const FLEET_SUB_TEST_DEPTH_M = 90;
export const FLEET_SUB_CRUSH_DEPTH_M = 150;

/**
 * Max ordered / actual depth (m) for fleet submarines.
 * Past {@link FLEET_SUB_CRUSH_DEPTH_M} so players may order into implosion risk.
 */
export const SUBMARINE_MAX_DEPTH_M = 180;

/**
 * Per-resolve chance the hull implodes while keel is **strictly deeper** than
 * {@link FLEET_SUB_CRUSH_DEPTH_M} (past crush only — not at exactly crush).
 */
export const SUBMARINE_IMPLOSION_CHANCE_PER_TURN = 0.25;

/**
 * Ships/subs linger in `condition: 'sinking'` for this many subsequent resolves
 * before becoming fully `sunk` (optics drop the contact). Kill-turn sets the
 * counter; countdown ticks at the start of each later resolve.
 */
export const VESSEL_SINKING_TURNS = 3;

/**
 * Fleet-boat dive / ascent rate (meters per in-game minute), positive-down change.
 * Default 3-min turn → {@link SUBMARINE_DEPTH_RATE_M_PER_MIN} × 3 ≈ 45 m toward ordered depth.
 * Crude playable stub — same rate up and down (emergency blow is just ordered 0 m).
 */
export const SUBMARINE_DEPTH_RATE_M_PER_MIN = 15;

/**
 * Fleet-sub noisemaker countermeasure — resolved turns between deploys.
 * Default 3 → ~9 in-game minutes at the default 3-min turn length.
 */
export const NOISEMAKER_COOLDOWN_TURNS = 3;

/**
 * Turns a deployed noisemaker stays acoustically active before going silent.
 * Default 8 → ~24 in-game minutes at the default 3-min turn length.
 */
export const NOISEMAKER_LIFETIME_TURNS = 8;

/**
 * Relative source loudness vs a typical underway propeller contact (1.0 = hull).
 * Hydrophone mix multiplies range×beam gain by this (capped at 1.0).
 * ~2.5× makes a stationary decoy compete with a nearby cruising hull.
 */
export const NOISEMAKER_SOURCE_LEVEL = 2.5;
