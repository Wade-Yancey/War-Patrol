/**
 * Torpedo + depth-charge + deck-gun + aircraft-attack combat model (v1).
 *
 * Torpedo hits are geometry-first: closest approach within a hull-breadth
 * gate using real length/beam, then scaled by how accurately the operator
 * identified target length (recognition manual). Aspect softens damage and
 * adds a small warhead dud chance — not the old 5–50% “did you hit” RNG table.
 * Fire headings come from the player's entered TDC solution (aim + course /
 * speed / range intercept) — never auto-filled from sim truth.
 * Deck guns mirror that calculator language for surface engagement (DD +
 * fleet sub when surfaced): same-turn shell impact from the entered solution,
 * surface targets only, finite magazines per hull class.
 * Aircraft attacks are umpire-ordered intercept / strafe / bombing runs that resolve
 * on turn advance from CPA geometry (depth-charge-like bands).
 * See docs/simulation-physics.md in the project store.
 */
import {
  KNOTS_TO_MPS,
  METERS_PER_NM,
  RADAR_SURFACE_DEPTH_M,
} from './constants.js';
import {
  bearingRangeNm,
  clamp,
  eastNorthMeters,
  lerpLatLonDepth,
  moveAlongHeading,
  normalizeHeading,
} from './geo.js';
import { shortestBearingDelta } from './hydrophone.js';
import { PERISCOPE_DEPTH_M } from './periscope.js';
import type {
  AircraftAttackMode,
  CombatLogEntry,
  DeckGunFireBlock,
  DeckGunFireOrder,
  DepthChargePattern,
  DepthChargeTrack,
  HullClass,
  LatLonDepth,
  OwnDamageEvent,
  TorpedoArcBlock,
  TorpedoRoomId,
  TorpedoTrack,
  UnitState,
  VesselType,
  WeaponDetonationEvent,
} from './types.js';
import { resolveBeamM, resolveLengthM } from './dimensions.js';
import { rearmBombLoad } from './aircraft.js';

// --- Torpedo (Mk 14–ish fleet-sub fish) ---

/** High-speed setting ~46 kn. */
export const TORPEDO_SPEED_KN = 46;

/** Max run at high-speed setting (~9,000 yd ≈ 4.5 nm). */
export const TORPEDO_MAX_RUN_NM = 4.5;

/** Default run depth (m) — shallow anti-surface. */
export const TORPEDO_DEFAULT_DEPTH_M = 3;

export const TORPEDO_MIN_DEPTH_M = 1;
export const TORPEDO_MAX_DEPTH_M = 25;

/** Fleet-sub forward torpedo room capacity (bow tubes / ready fish). */
export const FLEET_SUB_TORPEDO_FORWARD = 6;

/** Fleet-sub aft torpedo room capacity (stern tubes / ready fish). */
export const FLEET_SUB_TORPEDO_AFT = 4;

/**
 * Total fleet-sub fish at full rearm (forward + aft).
 * Finite magazines — depleted on fire; umpire rearm restores full rooms.
 */
export const FLEET_SUB_TORPEDO_LOAD = FLEET_SUB_TORPEDO_FORWARD + FLEET_SUB_TORPEDO_AFT;

/**
 * Resolved turns after the player presses Reload before that room can fire again.
 * At default 3-min in-game turns ≈ **15 in-game minutes** (~several wall-clock
 * minutes of live ordering). Deliberately slow for physical-tube live events.
 */
export const TORPEDO_RELOAD_TURNS = 5;

/**
 * Forward (bow) tube firing cone half-angle about own heading.
 * WWII fleet-boat bow tubes / gyro angles: fish must run roughly ahead —
 * mid of the historically plausible ±30–60° band (±45° → 90° total cone).
 */
export const TORPEDO_FORWARD_ARC_HALF_DEG = 45;

/**
 * Aft (stern) tube firing cone half-angle about own heading + 180°.
 * Stern tubes fire roughly astern — same ±45° half-angle as the bow room.
 */
export const TORPEDO_AFT_ARC_HALF_DEG = 45;

/**
 * Max fish in one queued spread order.
 * Upper bound across both rooms — the forward (bow) room carries the larger
 * magazine (`FLEET_SUB_TORPEDO_FORWARD` = 6); the aft room is separately
 * capped by its own smaller ready count (`FLEET_SUB_TORPEDO_AFT` = 4) at
 * every call site (`torpedoRoomReady` / `selected.ready`), so raising this
 * shared ceiling to the forward capacity does not let aft over-fire.
 */
export const TORPEDO_SPREAD_MAX_COUNT = FLEET_SUB_TORPEDO_FORWARD;

/**
 * Min angular spacing between adjacent fish in a spread (degrees).
 * Must stay well above zero — a 0° / 0.1° "spread" stacks every fish on the
 * same heading (at 1 nm, 0.1° is only ~3 m of lateral separation — tracks
 * look identical on the GT map). Floor at 1° (~32 m / ~35 yd at 1 nm) so
 * even the tightest legal fan is visibly separated while still fitting
 * multiple fish inside a destroyer beam hit gate at typical ranges.
 *
 * Lateral ≈ rangeNm · 1852 · tan(spreadDeg°) between adjacent fish.
 */
export const TORPEDO_SPREAD_MIN_DEG = 1;

/**
 * Max angular spacing between adjacent fish in a spread (degrees).
 * Wide fans for convoy columns / intentional single-fish-per-hull shots —
 * not the default for a concentrated salvo on one target.
 */
export const TORPEDO_SPREAD_MAX_DEG = 8;

/**
 * Calculator control step (degrees) for spread interval. Half-degree jumps
 * keep the dial coarse enough for museum play — the old 0.1° grid invited
 * microscopic fans that stacked on the plot.
 */
export const TORPEDO_SPREAD_STEP_DEG = 0.5;

/**
 * Default inter-fish spacing when operator leaves spreadDeg unset.
 *
 * Tuned for museum multi-hit on one hull (Wade): at 1 nm ≈ 48 m between
 * adjacent tips — visibly separated vs the old 0.1° stack (~3 m), yet still
 * inside a Fletcher beam gate (~62.5 m) and well inside an oiler/carrier
 * gate (~90 m). At the common 1.5 nm drill range, outer fish still fit
 * Cimarron / Shōkaku (~73 m < 90 m gate) so a centered solution can score
 * 2–3 hits on a long hull; Fletcher is center-only at 1.5 nm (gate tighter
 * than the fan) — dial down to 1° for DD multi-hit at that range, or up
 * toward max for a wide convoy fan.
 */
export const TORPEDO_SPREAD_DEFAULT_DEG = 1.5;

/**
 * Horizontal miss distance (m) inside which a geometric hit is possible
 * is derived from hull length/beam via {@link torpedoHullHalfBreadthM}.
 * This constant is a small pad added to the projected half-breadth
 * (modest CPA forgiveness — not a free hit).
 *
 * Tuning (ease sub hits): pad was 2 m; raised to 5 m so a near-chord
 * miss still contacts (~+3 m on every aspect). Fletcher beam gate
 * 59.5 → 62.5 m; end-on 8 → 11 m.
 */
export const TORPEDO_HIT_GATE_PAD_M = 5;

/**
 * @deprecated Fixed 90 m gate removed — use beam/length half-breadth.
 * Kept as a wide upper clamp so absurd dims cannot inflate the gate.
 */
export const TORPEDO_HIT_GATE_M = 90;

/**
 * Length-ID full credit: relative error |est−true|/true within this fraction
 * keeps the full geometric hit gate (recognition-manual class lengths match).
 *
 * Museum / forgiveness tuning: was 0.10 (±10%), then 0.15 (±15%); now 0.25
 * (±25%) so a reasonable-but-imperfect recognition-manual read (wrong sub-class,
 * rounded plate value) still keeps the full intercept chord for first-time players.
 */
export const TORPEDO_LENGTH_ID_FULL_FRAC = 0.25;

/**
 * Length-ID zero credit: relative error at or above this collapses the
 * effective hit gate to 0 (wrong ID → miss even on geometric contact).
 *
 * Museum / forgiveness tuning: was 0.40, then 0.50; now 0.75 so a near-miss
 * class pick (e.g. cruiser for DD) keeps a meaningful partial gate for much
 * longer before collapsing — only a wildly wrong ID (battleship for a sub) zeroes out.
 */
export const TORPEDO_LENGTH_ID_ZERO_FRAC = 0.75;

/** Base damage applied on a successful (non-dud) torpedo hit (health points). */
export const TORPEDO_HIT_DAMAGE = 45;

/**
 * Aspect → warhead dud % (track angle off target's bow-stern axis).
 * 90° = full beam (lowest dud); 0° = end-on (highest dud). Interpolate.
 *
 * Museum / forgiveness tuning: was end-on 18% → beam 3% (steeper falloff);
 * now end-on 10% → beam 2% — lower rates across the board and a gentler
 * (softer) curve between them so good geometry is rewarded more often,
 * while a real dud chance is kept at every aspect (never removed).
 */
export const TORPEDO_ASPECT_DUD_TABLE: ReadonlyArray<{ angleDeg: number; dudPct: number }> = [
  { angleDeg: 0, dudPct: 10 },
  { angleDeg: 15, dudPct: 7 },
  { angleDeg: 45, dudPct: 4 },
  { angleDeg: 90, dudPct: 2 },
];

/**
 * Aspect → damage factor vs {@link TORPEDO_HIT_DAMAGE}.
 * End-on glancing hits do less; beam shots apply full warhead.
 */
export const TORPEDO_ASPECT_DAMAGE_TABLE: ReadonlyArray<{
  angleDeg: number;
  damageFactor: number;
}> = [
  { angleDeg: 0, damageFactor: 0.55 },
  { angleDeg: 15, damageFactor: 0.7 },
  { angleDeg: 45, damageFactor: 0.88 },
  { angleDeg: 90, damageFactor: 1 },
];

/**
 * Max range (nm) for Controls torpedo-hit explosion cue attenuation.
 * Firer and target always get a cue when they are the involved units;
 * gain falls off with distance to the hit point.
 */
export const TORPEDO_HIT_CONTROLS_REF_NM = 4;

/**
 * Max wall-clock seconds for player-facing torpedo-hit SFX + Damage reveal.
 * Real intercept time within the turn can be up to `turnLengthSeconds` (often
 * 180 s); presentation scales proportionally into this window so long fish
 * runs do not make players wait the full intercept. Sim / GT tracks and
 * umpire Action log stay on resolve-time truth. Aligns with the DC stagger
 * dramatic window (~1½ min).
 */
export const TORPEDO_HIT_AUDIO_MAX_DELAY_SEC = 90;

/**
 * Umpire “near miss” band: horizontal CPA (track → target center) at or
 * below this many meters. Farther approaches are logged as far misses.
 * ~110 yd — inside a couple of ship lengths for destroyer/cruiser targets.
 */
export const TORPEDO_NEAR_MISS_M = 100;

/** Naval yard (nm/2000) for umpire miss-distance parentheticals. */
export const METERS_PER_NAVAL_YARD = METERS_PER_NM / 2000;

// --- Depth charges (DD rack / thrower stub) ---

/** Approximate sink rate (m/s) — ~10–15 ft/s order of magnitude. */
export const DEPTH_CHARGE_SINK_MPS = 3.5;

export const DEPTH_CHARGE_DEFAULT_DEPTH_M = 50;
export const DEPTH_CHARGE_MIN_DEPTH_M = 15;
export const DEPTH_CHARGE_MAX_DEPTH_M = 90;

/** Fletcher-class ready rack capacity (finite magazine; depletes per charge dropped). */
export const DESTROYER_DEPTH_CHARGE_LOAD = 24;

/**
 * Resolved turns after the player presses Reload before the DC rack can drop again.
 * Matches {@link TORPEDO_RELOAD_TURNS} — ~15 in-game minutes at default 3-min turns.
 */
export const DEPTH_CHARGE_RELOAD_TURNS = TORPEDO_RELOAD_TURNS;

/**
 * Base effect % at zero horizontal miss + perfect depth match (single charge).
 * Pattern spreads more charges; each rolls independently.
 */
export const DEPTH_CHARGE_BASE_EFFECT_PCT = 55;

/** Depth-match: within this many meters counts as good setting. */
export const DEPTH_CHARGE_DEPTH_GOOD_TOL_M = 10;

/** Depth-match: within this many meters still partial. */
export const DEPTH_CHARGE_DEPTH_PARTIAL_TOL_M = 25;

export const DEPTH_CHARGE_MOD_DEPTH_GOOD_PCT = 20;
export const DEPTH_CHARGE_MOD_DEPTH_PARTIAL_PCT = 5;
export const DEPTH_CHARGE_MOD_DEPTH_BAD_PCT = -25;

/**
 * Horizontal range bands (m) for additive range modifiers / effect gate.
 * Widened ~2.5× vs the original 25 / 55 / 90 m so a pattern has a meaningful
 * blast footprint in we-go play (lethal / damage / stun still use these gates).
 */
export const DEPTH_CHARGE_RANGE_CLOSE_M = 65;
export const DEPTH_CHARGE_RANGE_MED_M = 140;
export const DEPTH_CHARGE_RANGE_FAR_M = 225;

export const DEPTH_CHARGE_MOD_RANGE_CLOSE_PCT = 15;
export const DEPTH_CHARGE_MOD_RANGE_MED_PCT = 0;
export const DEPTH_CHARGE_MOD_RANGE_FAR_PCT = -20;
export const DEPTH_CHARGE_MOD_RANGE_OUT_PCT = -100;

/** Pattern discipline bonus (tight diamond vs hurried single). */
export const DEPTH_CHARGE_MOD_PATTERN: Record<DepthChargePattern, number> = {
  single: 0,
  pair: 5,
  pattern_3: 10,
  pattern_5: 12,
};

export const DEPTH_CHARGE_LETHAL_DAMAGE = 55;
export const DEPTH_CHARGE_DAMAGE_AMOUNT = 22;
export const DEPTH_CHARGE_STUN_DAMAGE = 8;

/**
 * Pattern → thrower lateral offsets (m, + = starboard of track heading).
 * Along-track spacing uses {@link depthChargeReleaseFractions} on the firer's
 * start→end move — charges trail along the path, not a single midpoint pile.
 *
 * Counts (ids kept for save/API compatibility):
 * single 1 · pair 4 · pattern_3 → 6 · pattern_5 → 10
 */
export const DEPTH_CHARGE_PATTERN_LATERAL_M: Record<
  DepthChargePattern,
  ReadonlyArray<number>
> = {
  single: [0],
  pair: [-42, -14, 14, 42],
  pattern_3: [-50, -25, 0, 25, 50, 12],
  pattern_5: [-55, -33, -11, 11, 33, 55, -22, 22, -44, 0],
};

/**
 * Legacy ahead/lateral offsets — used only when the firer barely moved
 * (stationary / creep) so a pattern still fans out along heading.
 */
export const DEPTH_CHARGE_PATTERN_OFFSETS: Record<
  DepthChargePattern,
  ReadonlyArray<{ aheadM: number; lateralM: number }>
> = {
  single: [{ aheadM: -40, lateralM: 0 }],
  pair: [
    { aheadM: -10, lateralM: -42 },
    { aheadM: -35, lateralM: -14 },
    { aheadM: -60, lateralM: 14 },
    { aheadM: -85, lateralM: 42 },
  ],
  pattern_3: [
    { aheadM: -10, lateralM: -50 },
    { aheadM: -30, lateralM: -25 },
    { aheadM: -50, lateralM: 0 },
    { aheadM: -70, lateralM: 25 },
    { aheadM: -90, lateralM: 50 },
    { aheadM: -110, lateralM: 12 },
  ],
  pattern_5: [
    { aheadM: -8, lateralM: -55 },
    { aheadM: -22, lateralM: -33 },
    { aheadM: -36, lateralM: -11 },
    { aheadM: -50, lateralM: 11 },
    { aheadM: -64, lateralM: 33 },
    { aheadM: -78, lateralM: 55 },
    { aheadM: -92, lateralM: -22 },
    { aheadM: -106, lateralM: 22 },
    { aheadM: -120, lateralM: -44 },
    { aheadM: -134, lateralM: 0 },
  ],
};

/** Min firer move (nm) before drops space along the track vs heading fan. */
export const DEPTH_CHARGE_TRACK_SPREAD_MIN_NM = 0.04;

// --- Deck gun (destroyer 5"/38–ish + fleet-sub 4"/50–ish surface fire) ---

/**
 * Shell speed for intercept lead (kn). Far faster than hulls / fish so time of
 * flight is short vs a 3-min turn — lead still matters at longer ranges.
 */
export const DECK_GUN_SHELL_SPEED_KN = 800;

/**
 * Practical max surface engagement range (nm). Fletcher 5"/38 can go farther;
 * museum stub keeps shots inside a playable plot band.
 */
export const DECK_GUN_MAX_RANGE_NM = 8;

/** Fletcher / Kagerō ready magazine (finite; depletes one shell per shot). */
export const DESTROYER_DECK_GUN_LOAD = 40;

/** Gato / fleet-sub ready magazine (smaller than DD). */
export const FLEET_SUB_DECK_GUN_LOAD = 20;

/**
 * Max rounds a destroyer may fire in one 3-min turn (museum-paced).
 * Fletcher 5"/38 cyclic ~15–22 rpm; short bursts are faster still — we cap at
 * **6** (~2 rpm averaged over the turn) so the 40-shell mag lasts several
 * engagements and the Guns CRT stays countable.
 */
export const DESTROYER_DECK_GUN_MAX_SHOTS_PER_TURN = 6;

/**
 * Max rounds a fleet-sub deck gun may fire in one 3-min turn.
 * Gato 4"/50 is slower on a rolling casing with a small exposed crew —
 * **3** rounds (~1 rpm) keeps the boat's 20-shell mag meaningful.
 */
export const FLEET_SUB_DECK_GUN_MAX_SHOTS_PER_TURN = 3;

/**
 * Wall-clock gap (seconds) between cannon-fire onsets for a multi-shot salvo
 * on Controls. Mirrors the torpedo same-moment hit stagger (250 ms) so crews
 * can count distinct reports. Physics still spaces shots across the turn
 * timeline; this is presentation only.
 */
export const DECK_GUN_FIRE_STAGGER_SEC = 0.25;

/**
 * Resolved turns after Reload before the deck gun can fire again.
 * Faster than tube/rack reload ({@link TORPEDO_RELOAD_TURNS}) — gun crew pace.
 * Applies once per **salvo** (not per individual round).
 */
export const DECK_GUN_RELOAD_TURNS = 2;

/**
 * Horizontal miss pad (m) added to projected half-breadth for a geometric hit.
 * Slightly more forgiving than torpedo pad — gun splash / spotting feel.
 */
export const DECK_GUN_HIT_GATE_PAD_M = 12;

/** Upper clamp on deck-gun hit gate (m) — same wide ceiling as torpedo. */
export const DECK_GUN_HIT_GATE_MAX_M = 90;

/** Base HP applied on a successful deck-gun hit (museum-scale; below torpedo). */
export const DECK_GUN_HIT_DAMAGE = 14;

/** Umpire / crew near-miss band for shell CPA (m). */
export const DECK_GUN_NEAR_MISS_M = 80;

/**
 * Short delay (s) after the cannon fire cue before the hit explosion plays on
 * Controls — keeps the muzzle report leading the blast for firer/target.
 */
export const DECK_GUN_HIT_AUDIO_DELAY_SEC = 0.85;

/**
 * Along-track release fractions in [0, 1] from move start→end for a pattern.
 * Spaced so a multi-charge rack leaves a trail, not one midpoint dump.
 */
export function depthChargeReleaseFractions(pattern: DepthChargePattern): number[] {
  const n = depthChargePatternCount(pattern);
  if (n <= 1) return [0.5];
  const first = 0.12;
  const last = 0.88;
  return Array.from({ length: n }, (_, i) => first + ((last - first) * i) / (n - 1));
}

/** Linear interpolate lat/lon (surface) between two points. */
export function lerpLatLon(
  a: Pick<LatLonDepth, 'lat' | 'lon'>,
  b: Pick<LatLonDepth, 'lat' | 'lon'>,
  t: number,
): LatLonDepth {
  const u = clamp(t, 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * u,
    lon: a.lon + (b.lon - a.lon) * u,
    depth: 0,
  };
}

// --- Lookout wake FoW ---

export const TORPEDO_WAKE_DETECT_MAX_NM = 2.5;
export const TORPEDO_WAKE_BASE_P = 0.55;
export const TORPEDO_WAKE_BEARING_STEP_DEG = 15;

// --- Acoustic range for depth-charge WAV ---

export const DEPTH_CHARGE_HYDROPHONE_RANGE_NM = 12;
/**
 * Controls bridge speakers — any vessel this close to a blast hears it.
 * Kept well outside the far damage band (~225 m ≈ 0.12 nm) so charges that
 * can hurt are always audible; quintic falloff still makes distant cues quiet.
 * Client also applies a modest damage-band gain boost (≤65 / 140 / 225 m) on
 * top of that curve so kill-radius blasts read louder than mid-range near-misses.
 */
export const DEPTH_CHARGE_CONTROLS_AUDIBLE_NM = 1.5;

/** Substeps per turn for weapon geometry. */
export const WEAPON_SUBSTEPS = 10;

export function depthChargePatternCount(pattern: DepthChargePattern): number {
  return DEPTH_CHARGE_PATTERN_OFFSETS[pattern]?.length ?? 1;
}

export function clampTorpedoDepth(depthM: number): number {
  return clamp(Math.round(depthM), TORPEDO_MIN_DEPTH_M, TORPEDO_MAX_DEPTH_M);
}

export function clampDepthChargeSetting(depthM: number): number {
  return clamp(Math.round(depthM), DEPTH_CHARGE_MIN_DEPTH_M, DEPTH_CHARGE_MAX_DEPTH_M);
}

export function normalizeDepthChargePattern(raw: unknown): DepthChargePattern {
  if (raw === 'pair' || raw === 'pattern_3' || raw === 'pattern_5' || raw === 'single') {
    return raw;
  }
  return 'single';
}

export function clampTorpedoSpreadCount(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(TORPEDO_SPREAD_MAX_COUNT, n);
}

export function clampTorpedoSpreadDeg(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return TORPEDO_SPREAD_DEFAULT_DEG;
  const rounded = Math.round(n / TORPEDO_SPREAD_STEP_DEG) * TORPEDO_SPREAD_STEP_DEG;
  // Re-round to the step's own decimal precision — dividing/multiplying by a
  // non-power-of-two step (0.5, formerly 0.1) reliably reintroduces float
  // noise (e.g. 3 -> 3.0000000000000004), which would otherwise leak into
  // readouts.
  const snapped = Math.round(rounded * 10) / 10;
  return clamp(snapped, TORPEDO_SPREAD_MIN_DEG, TORPEDO_SPREAD_MAX_DEG);
}

/**
 * Expected lateral separation (meters) between adjacent fish tips after
 * running `rangeNm` along their spread headings — flat-plane tan(δ) model
 * matching equirectangular track geometry. Useful for museum-range tuning
 * and verify coverage (e.g. 4° at 1 nm ≈ 130 m).
 */
export function torpedoSpreadLateralSeparationM(
  rangeNm: number,
  spreadDeg: number,
): number {
  const r = Math.max(0, Number(rangeNm) || 0);
  const spacing = clampTorpedoSpreadDeg(spreadDeg);
  return r * METERS_PER_NM * Math.tan((spacing * Math.PI) / 180);
}

/**
 * True headings for a fan centered on `centerHeading` (usually the
 * solution-derived fire heading, not raw LOS aim).
 * `spreadDeg` is the **inter-fish** interval (not total fan width).
 * Odd counts put one fish on the center axis; even counts straddle it.
 */
export function torpedoSpreadHeadings(
  centerHeading: number,
  count: number,
  spreadDeg: number,
): number[] {
  const n = clampTorpedoSpreadCount(count);
  const spacing = clampTorpedoSpreadDeg(spreadDeg);
  if (n <= 1) return [normalizeHeading(centerHeading)];
  const start = centerHeading - ((n - 1) / 2) * spacing;
  return Array.from({ length: n }, (_, i) => normalizeHeading(start + i * spacing));
}

export type TorpedoSolutionInput = {
  /**
   * LOS / aim bearing to the estimated present target position (**true** °).
   * UI may collect this as optics relative and convert before calling.
   */
  aimHeading: number;
  /** Player-estimated target true course (° — not AOB). */
  estimatedCourse: number;
  /** Player-estimated target speed (kn). */
  estimatedSpeedKn: number;
  /** Player-estimated range to target (nm). */
  estimatedRangeNm: number;
  /** Fish speed (kn). Defaults to {@link TORPEDO_SPEED_KN}. */
  torpedoSpeedKn?: number;
};

export type TorpedoSolutionResult = {
  /** Constant-speed intercept fire heading (true °) from the entered solution. */
  fireHeading: number;
  /** Time-to-intercept (s) under the entered estimates, or 0 if unsolvable. */
  interceptSec: number;
  /** False when geometry has no positive intercept (falls back to aim). */
  solvable: boolean;
};

/**
 * Compute the fire heading that would intercept a target under the player's
 * entered solution — never using sim truth.
 *
 * Aim = LOS bearing to the estimated present position; range places that point
 * along the aim; course/speed give estimated target motion. Constant fish speed
 * collision course (quadratic intercept). Wrong estimates → wrong lead → miss.
 * Stationary / zero-speed estimates → fire heading equals aim.
 * Unsolvable geometry (no positive root) falls back to aim.
 */
export function torpedoFireHeadingFromSolution(
  input: TorpedoSolutionInput,
): TorpedoSolutionResult {
  const aim = normalizeHeading(input.aimHeading);
  const rangeNm = Math.max(0, Number(input.estimatedRangeNm) || 0);
  const tgtSpeedKn = Math.max(0, Number(input.estimatedSpeedKn) || 0);
  const fishKn = Math.max(1, Number(input.torpedoSpeedKn) || TORPEDO_SPEED_KN);
  const course = normalizeHeading(input.estimatedCourse);

  if (rangeNm <= 0) {
    return { fireHeading: aim, interceptSec: 0, solvable: false };
  }

  const rangeM = rangeNm * METERS_PER_NM;
  const aimRad = (aim * Math.PI) / 180;
  const rEast = rangeM * Math.sin(aimRad);
  const rNorth = rangeM * Math.cos(aimRad);

  const vtMps = tgtSpeedKn * KNOTS_TO_MPS;
  const courseRad = (course * Math.PI) / 180;
  const vtEast = vtMps * Math.sin(courseRad);
  const vtNorth = vtMps * Math.cos(courseRad);

  const vfMps = fishKn * KNOTS_TO_MPS;
  const a = vtMps * vtMps - vfMps * vfMps;
  const b = 2 * (rEast * vtEast + rNorth * vtNorth);
  const c = rangeM * rangeM;

  const times: number[] = [];
  if (Math.abs(a) < 1e-9) {
    // Linear: B t + C = 0
    if (Math.abs(b) > 1e-9) {
      const t = -c / b;
      if (t > 1e-6) times.push(t);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrt = Math.sqrt(disc);
      const t1 = (-b - sqrt) / (2 * a);
      const t2 = (-b + sqrt) / (2 * a);
      if (t1 > 1e-6) times.push(t1);
      if (t2 > 1e-6) times.push(t2);
    }
  }

  if (times.length === 0) {
    return { fireHeading: aim, interceptSec: 0, solvable: false };
  }

  times.sort((x, y) => x - y);
  const t = times[0]!;
  const vfEast = rEast / t + vtEast;
  const vfNorth = rNorth / t + vtNorth;
  const fireHeading = normalizeHeading((Math.atan2(vfEast, vfNorth) * 180) / Math.PI);
  return { fireHeading, interceptSec: t, solvable: true };
}

export function isFleetSubTorpedoHull(
  unit: Pick<UnitState, 'type' | 'class'>,
): boolean {
  return unit.class === 'Fleet Submarine' || unit.type === 'Submarine';
}

export function torpedoRoomCapacity(room: TorpedoRoomId): number {
  return room === 'forward' ? FLEET_SUB_TORPEDO_FORWARD : FLEET_SUB_TORPEDO_AFT;
}

export function normalizeTorpedoRoomId(raw: unknown): TorpedoRoomId {
  return raw === 'aft' ? 'aft' : 'forward';
}

/** Tube-axis true heading for a room (bow = own HDG; stern = own HDG + 180°). */
export function torpedoRoomArcAxisHeading(
  ownHeadingDeg: number,
  room: TorpedoRoomId,
): number {
  const r = normalizeTorpedoRoomId(room);
  return r === 'aft'
    ? normalizeHeading(ownHeadingDeg + 180)
    : normalizeHeading(ownHeadingDeg);
}

/** Half-angle of the room's firing cone (degrees). */
export function torpedoRoomArcHalfDeg(room: TorpedoRoomId): number {
  return normalizeTorpedoRoomId(room) === 'aft'
    ? TORPEDO_AFT_ARC_HALF_DEG
    : TORPEDO_FORWARD_ARC_HALF_DEG;
}

/**
 * Signed gyro angle of a fish run heading vs the room's tube axis (−180, 180].
 * Forward: 0 = dead ahead; aft: 0 = dead astern.
 */
export function torpedoRoomGyroAngleDeg(
  ownHeadingDeg: number,
  fireHeadingDeg: number,
  room: TorpedoRoomId,
): number {
  return shortestBearingDelta(
    torpedoRoomArcAxisHeading(ownHeadingDeg, room),
    fireHeadingDeg,
  );
}

/** True when a single fish heading lies inside the room's firing cone. */
export function isTorpedoFireHeadingInRoomArc(
  ownHeadingDeg: number,
  fireHeadingDeg: number,
  room: TorpedoRoomId,
): boolean {
  return (
    Math.abs(torpedoRoomGyroAngleDeg(ownHeadingDeg, fireHeadingDeg, room)) <=
    torpedoRoomArcHalfDeg(room)
  );
}

export type TorpedoArcCheckInput = {
  ownHeadingDeg: number;
  room?: TorpedoRoomId | string;
  aimHeading: number;
  estimatedCourse: number;
  estimatedSpeedKn: number;
  estimatedRangeNm: number;
  spreadCount?: number;
  spreadDeg?: number;
};

export type TorpedoArcCheckResult = {
  ok: boolean;
  room: TorpedoRoomId;
  fireHeading: number;
  /** Gyro of the center fire heading vs the room axis (−180, 180]. */
  gyroDeg: number;
  halfDeg: number;
  headings: number[];
  /** Fish headings that fall outside the cone (empty when ok). */
  outOfArc: number[];
};

/**
 * Compute solution fire heading + spread fan, then test every fish against
 * the selected room's historically plausible cone (bow vs stern).
 */
export function checkTorpedoOrderArc(input: TorpedoArcCheckInput): TorpedoArcCheckResult {
  const room = normalizeTorpedoRoomId(input.room);
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: input.aimHeading,
    estimatedCourse: input.estimatedCourse,
    estimatedSpeedKn: input.estimatedSpeedKn,
    estimatedRangeNm: input.estimatedRangeNm,
  });
  const count = clampTorpedoSpreadCount(input.spreadCount);
  const spacing = clampTorpedoSpreadDeg(input.spreadDeg);
  const headings = torpedoSpreadHeadings(solution.fireHeading, count, spacing);
  const halfDeg = torpedoRoomArcHalfDeg(room);
  const outOfArc = headings.filter(
    (h) => !isTorpedoFireHeadingInRoomArc(input.ownHeadingDeg, h, room),
  );
  return {
    ok: outOfArc.length === 0,
    room,
    fireHeading: solution.fireHeading,
    gyroDeg: torpedoRoomGyroAngleDeg(input.ownHeadingDeg, solution.fireHeading, room),
    halfDeg,
    headings,
    outOfArc,
  };
}

/** Compact operator/umpire message when a fire order sits outside the room arc. */
export function formatTorpedoArcRejectMessage(check: TorpedoArcCheckResult): string {
  const roomLabel = check.room === 'aft' ? 'aft (stern)' : 'forward (bow)';
  const gyro = `${check.gyroDeg >= 0 ? '+' : ''}${Math.round(check.gyroDeg)}°`;
  return `${roomLabel} arc ±${check.halfDeg}° — gyro ${gyro} outside cone`;
}

/** Snapshot an out-of-arc resolve so the firing crew can be told next turn. */
export function buildTorpedoArcBlock(
  check: TorpedoArcCheckResult,
  turnNumber: number,
  ownHeadingDeg: number,
): TorpedoArcBlock {
  return {
    turnNumber,
    room: check.room,
    gyroDeg: check.gyroDeg,
    halfDeg: check.halfDeg,
    ownHeadingDeg: normalizeHeading(ownHeadingDeg),
  };
}

/** Controls notice for a salvo that never left the tubes (no fish expended). */
export function formatTorpedoArcBlockNotice(block: TorpedoArcBlock): string {
  const roomLabel = block.room === 'aft' ? 'Aft' : 'Forward';
  const axis = block.room === 'aft' ? 'stern' : 'bow';
  const gyro = `${block.gyroDeg >= 0 ? '+' : ''}${Math.round(block.gyroDeg)}°`;
  const hdg = String(Math.round(block.ownHeadingDeg)).padStart(3, '0');
  return (
    `Turn ${block.turnNumber}: ${roomLabel} salvo did not launch — hull on ${hdg}° put ` +
    `gyro ${gyro} outside the ±${block.halfDeg}° ${axis} arc. No fish expended.`
  );
}

/** Full forward/aft magazines for a fleet sub (or zeros for non-torpedo hulls). */
export function defaultTorpedoRooms(
  unit: Pick<UnitState, 'class' | 'type'>,
): { forward: number; aft: number } {
  if (!isFleetSubTorpedoHull(unit)) return { forward: 0, aft: 0 };
  return { forward: FLEET_SUB_TORPEDO_FORWARD, aft: FLEET_SUB_TORPEDO_AFT };
}

export function defaultDepthChargeLoad(unit: Pick<UnitState, 'class' | 'type'>): number {
  if (unit.class === 'Destroyer') return DESTROYER_DEPTH_CHARGE_LOAD;
  return 0;
}

/** Full deck-gun magazine for DD / fleet sub (0 for other hulls). */
export function defaultDeckGunLoad(unit: Pick<UnitState, 'class' | 'type'>): number {
  if (unit.class === 'Destroyer') return DESTROYER_DECK_GUN_LOAD;
  if (isFleetSubTorpedoHull(unit)) return FLEET_SUB_DECK_GUN_LOAD;
  return 0;
}

/** Class max rounds per turn (0 if the hull has no deck gun). */
export function maxDeckGunShotsPerTurn(unit: Pick<UnitState, 'class' | 'type'>): number {
  if (unit.class === 'Destroyer') return DESTROYER_DECK_GUN_MAX_SHOTS_PER_TURN;
  if (isFleetSubTorpedoHull(unit)) return FLEET_SUB_DECK_GUN_MAX_SHOTS_PER_TURN;
  return 0;
}

/**
 * Clamp ordered shot count to [1, min(class max, ready ammo)].
 * Legacy / missing `shotCount` → 1. Empty mag → 0 (caller should not fire).
 */
export function clampDeckGunShotCount(
  raw: number | undefined,
  unit: Pick<UnitState, 'class' | 'type' | 'deckGunLoad'>,
): number {
  const ammo = Math.max(0, Math.floor(Number(unit.deckGunLoad) || 0));
  if (ammo <= 0) return 0;
  const cap = Math.min(maxDeckGunShotsPerTurn(unit), ammo);
  if (cap <= 0) return 0;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(cap, n);
}

/**
 * Even fire fractions across the turn for a multi-shot salvo.
 * Single shot → [0] (legacy: impact uses shell TOF only). Multi → 0 … 1 inclusive.
 */
export function deckGunSalvoFireFractions(shotCount: number): number[] {
  const n = Math.max(1, Math.floor(shotCount));
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, i) => i / (n - 1));
}

export function torpedoRoomReady(
  unit: Pick<
    UnitState,
    | 'torpedoForward'
    | 'torpedoAft'
    | 'torpedoForwardAwaitingReload'
    | 'torpedoAftAwaitingReload'
    | 'torpedoForwardReloadTurnsRemaining'
    | 'torpedoAftReloadTurnsRemaining'
  >,
  room: TorpedoRoomId,
): number {
  return room === 'forward' ? unit.torpedoForward ?? 0 : unit.torpedoAft ?? 0;
}

export function torpedoRoomAwaitingReload(
  unit: Pick<UnitState, 'torpedoForwardAwaitingReload' | 'torpedoAftAwaitingReload'>,
  room: TorpedoRoomId,
): boolean {
  return room === 'forward'
    ? Boolean(unit.torpedoForwardAwaitingReload)
    : Boolean(unit.torpedoAftAwaitingReload);
}

export function torpedoRoomReloadTurnsRemaining(
  unit: Pick<
    UnitState,
    'torpedoForwardReloadTurnsRemaining' | 'torpedoAftReloadTurnsRemaining'
  >,
  room: TorpedoRoomId,
): number {
  const n =
    room === 'forward'
      ? unit.torpedoForwardReloadTurnsRemaining
      : unit.torpedoAftReloadTurnsRemaining;
  return Math.max(0, Math.floor(Number(n) || 0));
}

/** True when the room has fish and is not waiting on / mid reload. */
export function canFireTorpedoFromRoom(
  unit: Pick<
    UnitState,
    | 'type'
    | 'class'
    | 'condition'
    | 'torpedoForward'
    | 'torpedoAft'
    | 'torpedoForwardAwaitingReload'
    | 'torpedoAftAwaitingReload'
    | 'torpedoForwardReloadTurnsRemaining'
    | 'torpedoAftReloadTurnsRemaining'
    | 'torpedoLoad'
  >,
  room: TorpedoRoomId = 'forward',
): boolean {
  if (unit.condition === 'sunk') return false;
  if (!isFleetSubTorpedoHull(unit)) return false;
  if (torpedoRoomAwaitingReload(unit, room)) return false;
  if (torpedoRoomReloadTurnsRemaining(unit, room) > 0) return false;
  return torpedoRoomReady(unit, room) > 0;
}

export function canFireTorpedo(
  unit: Pick<
    UnitState,
    | 'type'
    | 'class'
    | 'condition'
    | 'torpedoForward'
    | 'torpedoAft'
    | 'torpedoForwardAwaitingReload'
    | 'torpedoAftAwaitingReload'
    | 'torpedoForwardReloadTurnsRemaining'
    | 'torpedoAftReloadTurnsRemaining'
    | 'torpedoLoad'
  >,
): boolean {
  return canFireTorpedoFromRoom(unit, 'forward') || canFireTorpedoFromRoom(unit, 'aft');
}

/**
 * Migrate legacy single `torpedoLoad` / missing room fields onto forward+aft.
 * New fleet subs without seeds get full rooms (6+4). Legacy load-only seeds
 * put fish in forward first, then aft.
 */
export function resolveTorpedoMagazineState(
  unit: Pick<UnitState, 'class' | 'type'> &
    Partial<
      Pick<
        UnitState,
        | 'torpedoLoad'
        | 'torpedoForward'
        | 'torpedoAft'
        | 'torpedoForwardAwaitingReload'
        | 'torpedoAftAwaitingReload'
        | 'torpedoForwardReloadTurnsRemaining'
        | 'torpedoAftReloadTurnsRemaining'
      >
    >,
): Pick<
  UnitState,
  | 'torpedoForward'
  | 'torpedoAft'
  | 'torpedoLoad'
  | 'torpedoForwardAwaitingReload'
  | 'torpedoAftAwaitingReload'
  | 'torpedoForwardReloadTurnsRemaining'
  | 'torpedoAftReloadTurnsRemaining'
> {
  if (!isFleetSubTorpedoHull(unit)) {
    return {
      torpedoForward: 0,
      torpedoAft: 0,
      torpedoLoad: 0,
      torpedoForwardAwaitingReload: false,
      torpedoAftAwaitingReload: false,
      torpedoForwardReloadTurnsRemaining: 0,
      torpedoAftReloadTurnsRemaining: 0,
    };
  }

  const hasForward = typeof unit.torpedoForward === 'number';
  const hasAft = typeof unit.torpedoAft === 'number';
  let forward: number;
  let aft: number;
  if (hasForward || hasAft) {
    forward = Math.max(0, Math.floor(Number(unit.torpedoForward) || 0));
    aft = Math.max(0, Math.floor(Number(unit.torpedoAft) || 0));
  } else if (typeof unit.torpedoLoad === 'number') {
    const load = Math.max(0, Math.floor(unit.torpedoLoad));
    forward = Math.min(FLEET_SUB_TORPEDO_FORWARD, load);
    aft = Math.min(FLEET_SUB_TORPEDO_AFT, Math.max(0, load - forward));
  } else {
    const rooms = defaultTorpedoRooms(unit);
    forward = rooms.forward;
    aft = rooms.aft;
  }

  forward = Math.min(FLEET_SUB_TORPEDO_FORWARD, forward);
  aft = Math.min(FLEET_SUB_TORPEDO_AFT, aft);

  return {
    torpedoForward: forward,
    torpedoAft: aft,
    torpedoLoad: forward + aft,
    torpedoForwardAwaitingReload: Boolean(unit.torpedoForwardAwaitingReload),
    torpedoAftAwaitingReload: Boolean(unit.torpedoAftAwaitingReload),
    torpedoForwardReloadTurnsRemaining: Math.max(
      0,
      Math.floor(Number(unit.torpedoForwardReloadTurnsRemaining) || 0),
    ),
    torpedoAftReloadTurnsRemaining: Math.max(
      0,
      Math.floor(Number(unit.torpedoAftReloadTurnsRemaining) || 0),
    ),
  };
}

/** Consume fish from a room and mark it awaiting player reload. */
export function consumeTorpedoRoom(
  unit: UnitState,
  room: TorpedoRoomId,
  count: number,
): UnitState {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return unit;
  if (room === 'forward') {
    const have = unit.torpedoForward ?? 0;
    const next = Math.max(0, have - n);
    return {
      ...unit,
      torpedoForward: next,
      torpedoLoad: next + (unit.torpedoAft ?? 0),
      torpedoForwardAwaitingReload: true,
    };
  }
  const have = unit.torpedoAft ?? 0;
  const next = Math.max(0, have - n);
  return {
    ...unit,
    torpedoAft: next,
    torpedoLoad: (unit.torpedoForward ?? 0) + next,
    torpedoAftAwaitingReload: true,
  };
}

/**
 * Start a reload cycle for a room (player pressed Reload).
 * Requires the room to be awaiting reload and not already counting down.
 */
export function startTorpedoRoomReload(
  unit: UnitState,
  room: TorpedoRoomId,
): { ok: true; unit: UnitState } | { ok: false; error: string } {
  if (!isFleetSubTorpedoHull(unit)) {
    return { ok: false, error: 'Only submarines have torpedo rooms' };
  }
  if (unit.condition === 'sunk') {
    return { ok: false, error: 'Unit sunk — torpedo rooms offline' };
  }
  if (!torpedoRoomAwaitingReload(unit, room)) {
    return { ok: false, error: 'Room is not awaiting reload' };
  }
  if (torpedoRoomReloadTurnsRemaining(unit, room) > 0) {
    return { ok: false, error: 'Reload already in progress' };
  }
  if (room === 'forward') {
    return {
      ok: true,
      unit: {
        ...unit,
        torpedoForwardReloadTurnsRemaining: TORPEDO_RELOAD_TURNS,
      },
    };
  }
  return {
    ok: true,
    unit: {
      ...unit,
      torpedoAftReloadTurnsRemaining: TORPEDO_RELOAD_TURNS,
    },
  };
}

/** Tick reload countdowns once per resolve; clear awaiting when a cycle finishes. */
export function advanceTorpedoRoomReloads(unit: UnitState): UnitState {
  if (!isFleetSubTorpedoHull(unit)) return unit;
  let next = unit;

  const fwdTurns = torpedoRoomReloadTurnsRemaining(unit, 'forward');
  if (fwdTurns > 0) {
    const remaining = fwdTurns - 1;
    next = {
      ...next,
      torpedoForwardReloadTurnsRemaining: remaining,
      ...(remaining === 0 ? { torpedoForwardAwaitingReload: false } : {}),
    };
  }

  const aftTurns = torpedoRoomReloadTurnsRemaining(next, 'aft');
  if (aftTurns > 0) {
    const remaining = aftTurns - 1;
    next = {
      ...next,
      torpedoAftReloadTurnsRemaining: remaining,
      ...(remaining === 0 ? { torpedoAftAwaitingReload: false } : {}),
    };
  }

  return next;
}

/** Umpire fiat: full forward + aft magazines; clear reload state. */
export function rearmTorpedoRooms(unit: UnitState): UnitState {
  if (!isFleetSubTorpedoHull(unit)) {
    return {
      ...unit,
      torpedoForward: 0,
      torpedoAft: 0,
      torpedoLoad: 0,
      torpedoForwardAwaitingReload: false,
      torpedoAftAwaitingReload: false,
      torpedoForwardReloadTurnsRemaining: 0,
      torpedoAftReloadTurnsRemaining: 0,
    };
  }
  const rooms = defaultTorpedoRooms(unit);
  return {
    ...unit,
    torpedoForward: rooms.forward,
    torpedoAft: rooms.aft,
    torpedoLoad: rooms.forward + rooms.aft,
    torpedoForwardAwaitingReload: false,
    torpedoAftAwaitingReload: false,
    torpedoForwardReloadTurnsRemaining: 0,
    torpedoAftReloadTurnsRemaining: 0,
  };
}

export function isDestroyerDcHull(unit: Pick<UnitState, 'class'>): boolean {
  return unit.class === 'Destroyer';
}

/** Normalize DC rack + reload fields (defaults full rack for destroyers). */
export function resolveDepthChargeMagazineState(
  unit: Pick<UnitState, 'class' | 'type'> &
    Partial<
      Pick<
        UnitState,
        | 'depthChargeLoad'
        | 'depthChargeAwaitingReload'
        | 'depthChargeReloadTurnsRemaining'
      >
    >,
): Pick<
  UnitState,
  'depthChargeLoad' | 'depthChargeAwaitingReload' | 'depthChargeReloadTurnsRemaining'
> {
  if (!isDestroyerDcHull(unit)) {
    return {
      depthChargeLoad: 0,
      depthChargeAwaitingReload: false,
      depthChargeReloadTurnsRemaining: 0,
    };
  }
  const load =
    typeof unit.depthChargeLoad === 'number'
      ? Math.min(
          DESTROYER_DEPTH_CHARGE_LOAD,
          Math.max(0, Math.floor(unit.depthChargeLoad)),
        )
      : DESTROYER_DEPTH_CHARGE_LOAD;
  return {
    depthChargeLoad: load,
    depthChargeAwaitingReload: Boolean(unit.depthChargeAwaitingReload),
    depthChargeReloadTurnsRemaining: Math.max(
      0,
      Math.floor(Number(unit.depthChargeReloadTurnsRemaining) || 0),
    ),
  };
}

export function canDropDepthCharges(
  unit: Pick<
    UnitState,
    | 'type'
    | 'class'
    | 'condition'
    | 'depthChargeLoad'
    | 'depthChargeAwaitingReload'
    | 'depthChargeReloadTurnsRemaining'
  >,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (!isDestroyerDcHull(unit)) return false;
  if (unit.depthChargeAwaitingReload) return false;
  if ((unit.depthChargeReloadTurnsRemaining ?? 0) > 0) return false;
  return (unit.depthChargeLoad ?? 0) > 0;
}

/** Consume rack charges and mark awaiting player reload. */
export function consumeDepthChargeRack(unit: UnitState, count: number): UnitState {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return unit;
  const next = Math.max(0, (unit.depthChargeLoad ?? 0) - n);
  return {
    ...unit,
    depthChargeLoad: next,
    depthChargeAwaitingReload: true,
  };
}

export function startDepthChargeReload(
  unit: UnitState,
): { ok: true; unit: UnitState } | { ok: false; error: string } {
  if (!isDestroyerDcHull(unit)) {
    return { ok: false, error: 'Only destroyers have depth-charge racks' };
  }
  if (unit.condition === 'sunk') {
    return { ok: false, error: 'Unit sunk — depth-charge rack offline' };
  }
  if (!unit.depthChargeAwaitingReload) {
    return { ok: false, error: 'Rack is not awaiting reload' };
  }
  if ((unit.depthChargeReloadTurnsRemaining ?? 0) > 0) {
    return { ok: false, error: 'Reload already in progress' };
  }
  return {
    ok: true,
    unit: {
      ...unit,
      depthChargeReloadTurnsRemaining: DEPTH_CHARGE_RELOAD_TURNS,
    },
  };
}

export function advanceDepthChargeReloads(unit: UnitState): UnitState {
  if (!isDestroyerDcHull(unit)) return unit;
  const turns = Math.max(0, Math.floor(Number(unit.depthChargeReloadTurnsRemaining) || 0));
  if (turns <= 0) return unit;
  const remaining = turns - 1;
  return {
    ...unit,
    depthChargeReloadTurnsRemaining: remaining,
    ...(remaining === 0 ? { depthChargeAwaitingReload: false } : {}),
  };
}

/** Umpire fiat: full DC rack; clear reload state. */
export function rearmDepthChargeRack(unit: UnitState): UnitState {
  if (!isDestroyerDcHull(unit)) {
    return {
      ...unit,
      depthChargeLoad: 0,
      depthChargeAwaitingReload: false,
      depthChargeReloadTurnsRemaining: 0,
    };
  }
  return {
    ...unit,
    depthChargeLoad: DESTROYER_DEPTH_CHARGE_LOAD,
    depthChargeAwaitingReload: false,
    depthChargeReloadTurnsRemaining: 0,
  };
}

export function isDeckGunHull(unit: Pick<UnitState, 'class' | 'type'>): boolean {
  return unit.class === 'Destroyer' || isFleetSubTorpedoHull(unit);
}

/**
 * Fleet-sub deck gun requires the boat surfaced / awash
 * (keel depth ≤ {@link RADAR_SURFACE_DEPTH_M}). Destroyers always qualify.
 */
export function canDeckGunFireFromDepth(
  unit: Pick<UnitState, 'type' | 'class' | 'position'>,
): boolean {
  if (!isDeckGunHull(unit)) return false;
  if (unit.type !== 'Submarine') return true;
  return unit.position.depth <= RADAR_SURFACE_DEPTH_M;
}

export function resolveDeckGunMagazineState(
  unit: Pick<UnitState, 'class' | 'type'> &
    Partial<
      Pick<
        UnitState,
        | 'deckGunLoad'
        | 'deckGunAwaitingReload'
        | 'deckGunReloadTurnsRemaining'
      >
    >,
): Pick<
  UnitState,
  'deckGunLoad' | 'deckGunAwaitingReload' | 'deckGunReloadTurnsRemaining'
> {
  if (!isDeckGunHull(unit)) {
    return {
      deckGunLoad: 0,
      deckGunAwaitingReload: false,
      deckGunReloadTurnsRemaining: 0,
    };
  }
  const capacity = defaultDeckGunLoad(unit);
  const load =
    typeof unit.deckGunLoad === 'number'
      ? Math.min(capacity, Math.max(0, Math.floor(unit.deckGunLoad)))
      : capacity;
  return {
    deckGunLoad: load,
    deckGunAwaitingReload: Boolean(unit.deckGunAwaitingReload),
    deckGunReloadTurnsRemaining: Math.max(
      0,
      Math.floor(Number(unit.deckGunReloadTurnsRemaining) || 0),
    ),
  };
}

export function canFireDeckGun(
  unit: Pick<
    UnitState,
    | 'class'
    | 'type'
    | 'condition'
    | 'position'
    | 'deckGunLoad'
    | 'deckGunAwaitingReload'
    | 'deckGunReloadTurnsRemaining'
  >,
): boolean {
  if (!isDeckGunHull(unit)) return false;
  if (unit.condition === 'sunk') return false;
  if (!canDeckGunFireFromDepth(unit)) return false;
  if (unit.deckGunAwaitingReload) return false;
  if ((unit.deckGunReloadTurnsRemaining ?? 0) > 0) return false;
  return (unit.deckGunLoad ?? 0) > 0;
}

export function consumeDeckGunShell(unit: UnitState): UnitState {
  return consumeDeckGunShells(unit, 1);
}

/** Consume `count` shells (1 each) and mark the gun awaiting reload after the salvo. */
export function consumeDeckGunShells(unit: UnitState, count: number): UnitState {
  if (!isDeckGunHull(unit)) return unit;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return unit;
  const next = Math.max(0, (unit.deckGunLoad ?? 0) - n);
  return {
    ...unit,
    deckGunLoad: next,
    deckGunAwaitingReload: true,
  };
}

export function startDeckGunReload(
  unit: UnitState,
): { ok: true; unit: UnitState } | { ok: false; error: string } {
  if (!isDeckGunHull(unit)) {
    return { ok: false, error: 'Only destroyers and fleet subs have a deck gun' };
  }
  if (unit.condition === 'sunk') {
    return { ok: false, error: 'Unit sunk — deck gun offline' };
  }
  if (!unit.deckGunAwaitingReload) {
    return { ok: false, error: 'Deck gun is not awaiting reload' };
  }
  if ((unit.deckGunReloadTurnsRemaining ?? 0) > 0) {
    return { ok: false, error: 'Reload already in progress' };
  }
  return {
    ok: true,
    unit: {
      ...unit,
      deckGunReloadTurnsRemaining: DECK_GUN_RELOAD_TURNS,
    },
  };
}

export function advanceDeckGunReloads(unit: UnitState): UnitState {
  if (!isDeckGunHull(unit)) return unit;
  const turns = Math.max(0, Math.floor(Number(unit.deckGunReloadTurnsRemaining) || 0));
  if (turns <= 0) return unit;
  const remaining = turns - 1;
  return {
    ...unit,
    deckGunReloadTurnsRemaining: remaining,
    ...(remaining === 0 ? { deckGunAwaitingReload: false } : {}),
  };
}

/** Umpire fiat: full deck-gun magazine; clear reload state. */
export function rearmDeckGun(unit: UnitState): UnitState {
  if (!isDeckGunHull(unit)) {
    return {
      ...unit,
      deckGunLoad: 0,
      deckGunAwaitingReload: false,
      deckGunReloadTurnsRemaining: 0,
    };
  }
  return {
    ...unit,
    deckGunLoad: defaultDeckGunLoad(unit),
    deckGunAwaitingReload: false,
    deckGunReloadTurnsRemaining: 0,
  };
}

/**
 * Umpire one-click rearm: restores class-appropriate magazines
 * (torpedo rooms and/or DC rack and/or deck gun) and clears reload timers.
 */
export function rearmUnitWeapons(unit: UnitState): UnitState {
  let next = rearmTorpedoRooms(unit);
  next = rearmDepthChargeRack(next);
  next = rearmBombLoad(next);
  next = rearmDeckGun(next);
  return next;
}

/** Tick all weapon reload countdowns once per resolve. */
export function advanceWeaponReloads(unit: UnitState): UnitState {
  return advanceDeckGunReloads(advanceDepthChargeReloads(advanceTorpedoRoomReloads(unit)));
}

/** Deterministic 0–1 from string seed. */
export function weaponRng01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
}

/** Smallest angle between fish track and target bow-stern axis → [0, 90]. */
export function torpedoAspectAngleDeg(fishHeading: number, targetHeading: number): number {
  let d = Math.abs(((fishHeading - targetHeading + 540) % 360) - 180);
  if (d > 90) d = 180 - d;
  return d;
}

/**
 * Projected half-breadth (m) of a rectangular hull vs an approaching track.
 * aspectDeg 0 = end-on (narrow → beam/2); 90 = beam aspect (length/2).
 */
export function torpedoHullHalfBreadthM(
  lengthM: number,
  beamM: number,
  aspectDeg: number,
): number {
  const len = Math.max(1, lengthM);
  const beam = Math.max(1, beamM);
  const a = (clamp(aspectDeg, 0, 90) * Math.PI) / 180;
  return (beam / 2) * Math.cos(a) + (len / 2) * Math.sin(a);
}

/** Geometric hit gate = projected half-breadth + pad, capped. */
export function torpedoHitGateM(lengthM: number, beamM: number, aspectDeg: number): number {
  const half = torpedoHullHalfBreadthM(lengthM, beamM, aspectDeg);
  return Math.min(TORPEDO_HIT_GATE_M, half + TORPEDO_HIT_GATE_PAD_M);
}

/**
 * How accurately the operator's length estimate matches true OA length.
 * Returns 0–1 scale applied to the true geometric hit gate.
 * Symmetric: over- and under-estimates both shrink the intercept chord.
 * Perfect / within {@link TORPEDO_LENGTH_ID_FULL_FRAC} → 1;
 * at/above {@link TORPEDO_LENGTH_ID_ZERO_FRAC} → 0.
 */
export function torpedoLengthIdScale(estimatedLengthM: number, trueLengthM: number): number {
  const truth = Math.max(1, trueLengthM);
  const est = Math.max(0, Number(estimatedLengthM) || 0);
  if (est <= 0) return 0;
  const relErr = Math.abs(est - truth) / truth;
  if (relErr <= TORPEDO_LENGTH_ID_FULL_FRAC) return 1;
  if (relErr >= TORPEDO_LENGTH_ID_ZERO_FRAC) return 0;
  const span = TORPEDO_LENGTH_ID_ZERO_FRAC - TORPEDO_LENGTH_ID_FULL_FRAC;
  return 1 - (relErr - TORPEDO_LENGTH_ID_FULL_FRAC) / span;
}

/**
 * Effective hit gate after length identification quality.
 * Longer true targets still present a larger chord; wrong length shrinks it.
 */
export function torpedoEffectiveHitGateM(
  trueLengthM: number,
  trueBeamM: number,
  aspectDeg: number,
  estimatedLengthM: number,
): number {
  const trueGate = torpedoHitGateM(trueLengthM, trueBeamM, aspectDeg);
  return trueGate * torpedoLengthIdScale(estimatedLengthM, trueLengthM);
}

function interpolateAspectTable(
  aspectDeg: number,
  table: ReadonlyArray<{ angleDeg: number; value: number }>,
): number {
  const a = clamp(aspectDeg, 0, 90);
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i]!;
    const hi = table[i + 1]!;
    if (a >= lo.angleDeg && a <= hi.angleDeg) {
      const t = (a - lo.angleDeg) / (hi.angleDeg - lo.angleDeg || 1);
      return lo.value + t * (hi.value - lo.value);
    }
  }
  return table[table.length - 1]!.value;
}

/** Interpolate warhead dud % from the aspect table. */
export function torpedoDudPctFromAspect(aspectDeg: number): number {
  return interpolateAspectTable(
    aspectDeg,
    TORPEDO_ASPECT_DUD_TABLE.map((r) => ({ angleDeg: r.angleDeg, value: r.dudPct })),
  );
}

/** Interpolate damage factor (0–1) from the aspect table. */
export function torpedoDamageFactorFromAspect(aspectDeg: number): number {
  return interpolateAspectTable(
    aspectDeg,
    TORPEDO_ASPECT_DAMAGE_TABLE.map((r) => ({
      angleDeg: r.angleDeg,
      value: r.damageFactor,
    })),
  );
}

export type TorpedoHitRollInput = {
  /** Geometric miss distance at closest approach (m). */
  missDistanceM: number;
  fishHeading: number;
  targetHeading: number;
  /** True target length (sim) — never shown to players. */
  trueLengthM: number;
  /** True target beam (sim). */
  trueBeamM: number;
  /**
   * Operator length estimate from the TDC / recognition manual (m).
   * Scales the true geometric gate — wrong ID shrinks the intercept chord.
   */
  estimatedLengthM: number;
  /** Fish run depth vs target keel — surface targets need shallow fish. */
  depthOk: boolean;
  seed: string;
};

export type TorpedoHitRollResult = {
  /** True geometric contact that detonated (damage applied). */
  hit: boolean;
  /** Geometric contact but warhead dud — no damage. */
  dud: boolean;
  /** HP to apply when hit && !dud. */
  damage: number;
  aspectDeg: number;
  dudPct: number;
  halfBreadthM: number;
  /** True hull gate before length-ID scale. */
  trueHitGateM: number;
  /** Effective gate after length-ID scale (used for the miss check). */
  hitGateM: number;
  /** 0–1 length identification quality. */
  lengthIdScale: number;
  geometricMiss: boolean;
};

/**
 * Resolve one fish vs one target: geometry gate from hull dims, scaled by
 * length-ID quality, then aspect dud roll. Successful hits scale damage by
 * aspect (end-on softens).
 */
export function resolveTorpedoHit(input: TorpedoHitRollInput): TorpedoHitRollResult {
  const aspectDeg = torpedoAspectAngleDeg(input.fishHeading, input.targetHeading);
  const halfBreadthM = torpedoHullHalfBreadthM(
    input.trueLengthM,
    input.trueBeamM,
    aspectDeg,
  );
  const trueHitGateM = torpedoHitGateM(input.trueLengthM, input.trueBeamM, aspectDeg);
  const lengthIdScale = torpedoLengthIdScale(input.estimatedLengthM, input.trueLengthM);
  const hitGateM = trueHitGateM * lengthIdScale;
  const dudPct = torpedoDudPctFromAspect(aspectDeg);
  const damageFactor = torpedoDamageFactorFromAspect(aspectDeg);
  const damage = Math.max(1, Math.round(TORPEDO_HIT_DAMAGE * damageFactor));

  if (!input.depthOk || input.missDistanceM > hitGateM) {
    return {
      hit: false,
      dud: false,
      damage: 0,
      aspectDeg,
      dudPct,
      halfBreadthM,
      trueHitGateM,
      hitGateM,
      lengthIdScale,
      geometricMiss: true,
    };
  }

  const roll = weaponRng01(input.seed) * 100;
  if (roll < dudPct) {
    return {
      hit: false,
      dud: true,
      damage: 0,
      aspectDeg,
      dudPct,
      halfBreadthM,
      trueHitGateM,
      hitGateM,
      lengthIdScale,
      geometricMiss: false,
    };
  }

  return {
    hit: true,
    dud: false,
    damage,
    aspectDeg,
    dudPct,
    halfBreadthM,
    trueHitGateM,
    hitGateM,
    lengthIdScale,
    geometricMiss: false,
  };
}

export type DepthChargeEffectInput = {
  horizontalMissM: number;
  depthErrorM: number;
  pattern: DepthChargePattern;
  seed: string;
};

/**
 * Depth-charge effect: base % + depth-match + range + pattern mods → damage band.
 * Returns damage points (0 = no effect).
 */
export function resolveDepthChargeEffect(input: DepthChargeEffectInput): {
  damage: number;
  effectPct: number;
} {
  const absDepthErr = Math.abs(input.depthErrorM);
  let depthMod = DEPTH_CHARGE_MOD_DEPTH_BAD_PCT;
  if (absDepthErr <= DEPTH_CHARGE_DEPTH_GOOD_TOL_M) {
    depthMod = DEPTH_CHARGE_MOD_DEPTH_GOOD_PCT;
  } else if (absDepthErr <= DEPTH_CHARGE_DEPTH_PARTIAL_TOL_M) {
    depthMod = DEPTH_CHARGE_MOD_DEPTH_PARTIAL_PCT;
  }

  let rangeMod = DEPTH_CHARGE_MOD_RANGE_OUT_PCT;
  if (input.horizontalMissM <= DEPTH_CHARGE_RANGE_CLOSE_M) {
    rangeMod = DEPTH_CHARGE_MOD_RANGE_CLOSE_PCT;
  } else if (input.horizontalMissM <= DEPTH_CHARGE_RANGE_MED_M) {
    rangeMod = DEPTH_CHARGE_MOD_RANGE_MED_PCT;
  } else if (input.horizontalMissM <= DEPTH_CHARGE_RANGE_FAR_M) {
    rangeMod = DEPTH_CHARGE_MOD_RANGE_FAR_PCT;
  }

  if (rangeMod <= -100) {
    return { damage: 0, effectPct: 0 };
  }

  const patternMod = DEPTH_CHARGE_MOD_PATTERN[input.pattern] ?? 0;
  const effectPct = clamp(
    DEPTH_CHARGE_BASE_EFFECT_PCT + depthMod + rangeMod + patternMod,
    0,
    95,
  );
  const roll = weaponRng01(input.seed) * 100;
  if (roll >= effectPct) return { damage: 0, effectPct };

  // Severity from how good the geometry was (not a second RNG).
  const quality = effectPct / 95;
  if (quality >= 0.75 && input.horizontalMissM <= DEPTH_CHARGE_RANGE_CLOSE_M) {
    return { damage: DEPTH_CHARGE_LETHAL_DAMAGE, effectPct };
  }
  if (quality >= 0.45) {
    return { damage: DEPTH_CHARGE_DAMAGE_AMOUNT, effectPct };
  }
  return { damage: DEPTH_CHARGE_STUN_DAMAGE, effectPct };
}

export function coarsenWakeRelativeBearing(relDeg: number): number {
  const step = TORPEDO_WAKE_BEARING_STEP_DEG;
  const clamped = clamp(relDeg, -180, 180);
  return Math.round(clamped / step) * step;
}

export function torpedoWakeDetectProbability(rangeNm: number): number {
  if (rangeNm <= 0 || rangeNm > TORPEDO_WAKE_DETECT_MAX_NM) return 0;
  const proximity = 1 - rangeNm / TORPEDO_WAKE_DETECT_MAX_NM;
  return clamp(TORPEDO_WAKE_BASE_P * (0.35 + 0.65 * proximity), 0, 0.85);
}

export function offsetAlongHeading(
  pos: LatLonDepth,
  headingDeg: number,
  aheadM: number,
  lateralM: number,
): LatLonDepth {
  const along = moveAlongHeading(pos, headingDeg, aheadM);
  const lateralHdg = normalizeHeading(headingDeg + 90);
  return moveAlongHeading(along, lateralHdg, lateralM);
}

export function createTorpedoTrack(opts: {
  id: string;
  firerUnitId: string;
  position: LatLonDepth;
  heading: number;
  runDepthM: number;
  launchedTurn: number;
  estimatedCourse: number;
  estimatedSpeedKn: number;
  estimatedRangeNm: number;
  estimatedLengthM: number;
}): TorpedoTrack {
  const launch = {
    lat: opts.position.lat,
    lon: opts.position.lon,
    depth: clampTorpedoDepth(opts.runDepthM),
  };
  return {
    id: opts.id,
    firerUnitId: opts.firerUnitId,
    launchPosition: { ...launch },
    position: { ...launch },
    heading: normalizeHeading(opts.heading),
    speedKn: TORPEDO_SPEED_KN,
    remainingRunNm: TORPEDO_MAX_RUN_NM,
    runDepthM: clampTorpedoDepth(opts.runDepthM),
    launchedTurn: opts.launchedTurn,
    status: 'running',
    estimatedCourse: normalizeHeading(opts.estimatedCourse),
    estimatedSpeedKn: Math.max(0, opts.estimatedSpeedKn),
    estimatedRangeNm: Math.max(0, opts.estimatedRangeNm),
    estimatedLengthM: Math.max(0, opts.estimatedLengthM),
    path: [{ lat: launch.lat, lon: launch.lon }],
  };
}

export function createDepthChargeTracks(opts: {
  idPrefix: string;
  firerUnitId: string;
  /**
   * Firer position at turn start (pre-kinematics). With {@link endPosition},
   * multi-charge patterns space drops along this segment.
   */
  startPosition: LatLonDepth;
  /** Firer position after kinematics this turn. */
  endPosition: LatLonDepth;
  /** Track / bow heading for lateral thrower offsets. */
  dropHeading: number;
  pattern: DepthChargePattern;
  depthSettingM: number;
  launchedTurn: number;
}): DepthChargeTrack[] {
  const setting = clampDepthChargeSetting(opts.depthSettingM);
  const pattern = opts.pattern;
  const laterals =
    DEPTH_CHARGE_PATTERN_LATERAL_M[pattern] ?? DEPTH_CHARGE_PATTERN_LATERAL_M.single;
  const fractions = depthChargeReleaseFractions(pattern);
  const trackNm = bearingRangeNm(opts.startPosition, opts.endPosition).rangeNm;
  const useTrack = trackNm >= DEPTH_CHARGE_TRACK_SPREAD_MIN_NM;
  const legacy =
    DEPTH_CHARGE_PATTERN_OFFSETS[pattern] ?? DEPTH_CHARGE_PATTERN_OFFSETS.single;

  return fractions.map((frac, i) => {
    let pos: LatLonDepth;
    if (useTrack) {
      const along = lerpLatLon(opts.startPosition, opts.endPosition, frac);
      const lateralM = laterals[i] ?? 0;
      pos =
        lateralM === 0
          ? along
          : offsetAlongHeading(along, opts.dropHeading, 0, lateralM);
    } else {
      const off = legacy[i] ?? legacy[0]!;
      pos = offsetAlongHeading(
        opts.endPosition,
        opts.dropHeading,
        off.aheadM,
        off.lateralM,
      );
    }
    const launch = { lat: pos.lat, lon: pos.lon, depth: 0 };
    return {
      id: `${opts.idPrefix}-${i}`,
      firerUnitId: opts.firerUnitId,
      launchPosition: { ...launch },
      position: { ...launch },
      depthSettingM: setting,
      sinkRateMps: DEPTH_CHARGE_SINK_MPS,
      status: 'sinking' as const,
      launchedTurn: opts.launchedTurn,
      pattern,
      path: [{ lat: launch.lat, lon: launch.lon, depth: 0 }],
    };
  });
}

export function advanceTorpedo(track: TorpedoTrack, dtSeconds: number): TorpedoTrack {
  if (track.status !== 'running') return track;
  const distanceM = track.speedKn * KNOTS_TO_MPS * dtSeconds;
  const distanceNm = distanceM / METERS_PER_NM;
  const remaining = track.remainingRunNm - distanceNm;
  const launchPosition = track.launchPosition ?? {
    lat: track.path?.[0]?.lat ?? track.position.lat,
    lon: track.path?.[0]?.lon ?? track.position.lon,
    depth: track.runDepthM,
  };
  const prevPath = track.path?.length
    ? track.path
    : [{ lat: launchPosition.lat, lon: launchPosition.lon }];

  if (remaining <= 0) {
    const spent = moveAlongHeading(
      track.position,
      track.heading,
      Math.max(0, track.remainingRunNm) * METERS_PER_NM,
    );
    const end = { lat: spent.lat, lon: spent.lon };
    return {
      ...track,
      launchPosition,
      position: { ...spent, depth: track.runDepthM },
      remainingRunNm: 0,
      status: 'expired',
      path: appendPathPoint(prevPath, end),
    };
  }
  const next = moveAlongHeading(track.position, track.heading, distanceM);
  const end = { lat: next.lat, lon: next.lon };
  return {
    ...track,
    launchPosition,
    position: { ...next, depth: track.runDepthM },
    remainingRunNm: remaining,
    path: appendPathPoint(prevPath, end),
  };
}

function appendPathPoint(
  path: Array<{ lat: number; lon: number }>,
  pt: { lat: number; lon: number },
  minStepDeg = 1e-5,
): Array<{ lat: number; lon: number }> {
  const last = path[path.length - 1];
  if (
    last &&
    Math.abs(last.lat - pt.lat) < minStepDeg &&
    Math.abs(last.lon - pt.lon) < minStepDeg
  ) {
    return path;
  }
  // Cap path length for save size (keep launch + evenly spaced + tip).
  const next = [...path, pt];
  if (next.length <= 48) return next;
  const launch = next[0]!;
  const tip = next[next.length - 1]!;
  const mid = next.slice(1, -1);
  const stride = Math.ceil(mid.length / 40);
  const sampled = mid.filter((_, i) => i % stride === 0);
  return [launch, ...sampled, tip];
}

export function advanceDepthCharge(
  track: DepthChargeTrack,
  dtSeconds: number,
): DepthChargeTrack {
  if (track.status !== 'sinking') return track;
  const launchPosition = track.launchPosition ?? {
    lat: track.position.lat,
    lon: track.position.lon,
    depth: 0,
  };
  const prevPath = track.path?.length
    ? track.path
    : [{ lat: launchPosition.lat, lon: launchPosition.lon, depth: 0 }];
  const nextDepth = track.position.depth + track.sinkRateMps * dtSeconds;
  if (nextDepth >= track.depthSettingM) {
    const end = {
      lat: track.position.lat,
      lon: track.position.lon,
      depth: track.depthSettingM,
    };
    return {
      ...track,
      launchPosition,
      position: { ...track.position, depth: track.depthSettingM },
      status: 'detonated',
      detonatedAtDepthM: track.depthSettingM,
      path: [...prevPath, end].slice(-8),
    };
  }
  const mid = {
    lat: track.position.lat,
    lon: track.position.lon,
    depth: nextDepth,
  };
  // Only append when depth moved meaningfully (horizontal is fixed).
  const last = prevPath[prevPath.length - 1];
  const path =
    last && Math.abs(last.depth - nextDepth) < 2 ? prevPath : [...prevPath, mid].slice(-8);
  return {
    ...track,
    launchPosition,
    position: { ...track.position, depth: nextDepth },
    path,
  };
}

export function horizontalMissMeters(
  from: Pick<LatLonDepth, 'lat' | 'lon'>,
  to: Pick<LatLonDepth, 'lat' | 'lon'>,
): number {
  const { east, north } = eastNorthMeters(from, to);
  return Math.hypot(east, north);
}

/**
 * Closest point on the great-circle-local segment `from`→`to` to `target`.
 * `t` is the clamped fraction along the segment (0 = from, 1 = to).
 */
export function segmentClosestPoint(
  from: LatLonDepth,
  to: LatLonDepth,
  target: Pick<LatLonDepth, 'lat' | 'lon'>,
): { lat: number; lon: number; t: number; missM: number } {
  const { east: te, north: tn } = eastNorthMeters(from, target);
  const { east: se, north: sn } = eastNorthMeters(from, to);
  const segLen2 = se * se + sn * sn;
  if (segLen2 < 1e-6) {
    return {
      lat: from.lat,
      lon: from.lon,
      t: 0,
      missM: Math.hypot(te, tn),
    };
  }
  let t = (te * se + tn * sn) / segLen2;
  t = clamp(t, 0, 1);
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lon: from.lon + (to.lon - from.lon) * t,
    t,
    missM: Math.hypot(te - se * t, tn - sn * t),
  };
}

export function segmentClosestMissM(
  from: LatLonDepth,
  to: LatLonDepth,
  target: Pick<LatLonDepth, 'lat' | 'lon'>,
): number {
  return segmentClosestPoint(from, to, target).missM;
}

/** Near vs far band for umpire torpedo miss copy. */
export function torpedoMissBand(missM: number): 'near' | 'far' {
  return Math.max(0, missM) <= TORPEDO_NEAR_MISS_M ? 'near' : 'far';
}

/**
 * Format horizontal CPA for the umpire combat log.
 * Meters primary (matches hit-gate / DC miss); naval yards parenthetical.
 */
export function formatTorpedoMissDistance(missM: number): string {
  const m = Math.max(0, Number(missM) || 0);
  const yd = m / METERS_PER_NAVAL_YARD;
  if (m < 1) {
    return `${m.toFixed(1)} m (<1 yd)`;
  }
  return `${Math.round(m)} m (${Math.round(yd)} yd)`;
}

/**
 * Record a closer horizontal approach on a running fish (persists across turns).
 * Distance is track→target-center meters — same metric as {@link resolveTorpedoHit}.
 * Only replaces the stored CPA when `missM` is strictly nearer (nearest contact).
 */
export function recordTorpedoClosestApproach(
  fish: TorpedoTrack,
  missM: number,
  unitId: string,
  unitName?: string,
): TorpedoTrack {
  const m = Math.max(0, Number(missM) || 0);
  if (!(m >= 0) || !unitId) return fish;
  if (fish.closestApproachM != null && m >= fish.closestApproachM) return fish;
  const name = (unitName ?? '').trim();
  return {
    ...fish,
    closestApproachM: m,
    closestApproachUnitId: unitId,
    ...(name ? { closestApproachUnitName: name } : { closestApproachUnitName: undefined }),
  };
}

/**
 * Nearest eligible contact along one track segment (horizontal CPA to centers).
 * Skips firer and non-targets. Used by resolve and verify to pick Platte@200 m
 * over Neosho@6000 m.
 */
export function nearestTorpedoApproachOnSegment(
  from: LatLonDepth,
  to: LatLonDepth,
  candidates: readonly UnitState[],
  firerUnitId: string,
): { unitId: string; unitName: string; missM: number } | null {
  let best: { unitId: string; unitName: string; missM: number } | null = null;
  for (const target of candidates) {
    if (target.id === firerUnitId) continue;
    if (!isTorpedoTarget(target)) continue;
    const missM = segmentClosestMissM(from, to, target.position);
    if (best == null || missM < best.missM) {
      best = { unitId: target.id, unitName: target.name, missM };
    }
  }
  return best;
}

/**
 * Umpire CRT summary when a fish exhausts without a hit/dud.
 * Names the **nearest contact** CPA (not the aimed solution target).
 */
export function formatTorpedoMissLogSummary(opts: {
  firerName: string;
  targetName?: string;
  closestApproachM?: number;
}): string {
  const firer = opts.firerName || 'unknown';
  const cpa = opts.closestApproachM;
  if (cpa == null || !(cpa >= 0) || Number.isNaN(cpa)) {
    return `Torpedo from ${firer} exhausted run (miss / end)`;
  }
  const band = torpedoMissBand(cpa) === 'near' ? 'near miss' : 'far miss';
  const dist = formatTorpedoMissDistance(cpa);
  if (opts.targetName) {
    return `Torpedo from ${firer} MISSED ${opts.targetName} — CPA ${dist} (${band})`;
  }
  return `Torpedo from ${firer} MISSED — CPA ${dist} (${band})`;
}

/**
 * Compact umpire GT / AAR weapon-track label for an exhausted fish.
 * Example: `FISH · MISS Platte 200m (FAR)`.
 */
export function formatTorpedoMissTrackLabel(opts: {
  closestApproachM?: number;
  targetName?: string;
}): string {
  const cpa = opts.closestApproachM;
  if (cpa == null || !(cpa >= 0) || Number.isNaN(cpa)) {
    return 'FISH · EXHAUSTED';
  }
  const band = torpedoMissBand(cpa) === 'near' ? 'NEAR' : 'FAR';
  const dist = `${Math.round(cpa)}m`;
  const name = (opts.targetName ?? '').trim();
  if (name) {
    return `FISH · MISS ${name} ${dist} (${band})`;
  }
  return `FISH · MISS ${dist} (${band})`;
}

/** Resolve display name for a fish's stored nearest-contact CPA. */
export function torpedoMissNearestContactName(
  fish: Pick<TorpedoTrack, 'closestApproachUnitId' | 'closestApproachUnitName'>,
  units?: readonly Pick<UnitState, 'id' | 'name'>[],
): string | undefined {
  const snap = (fish.closestApproachUnitName ?? '').trim();
  if (snap) return snap;
  const id = fish.closestApproachUnitId;
  if (!id || !units?.length) return undefined;
  return units.find((u) => u.id === id)?.name;
}

/**
 * Snap a fish track to the hit (or dud contact) point on its last advance
 * segment and truncate the GT path so the trail ends at the collision.
 */
export function truncateTorpedoAtHit(
  prior: TorpedoTrack,
  advanced: TorpedoTrack,
  before: LatLonDepth,
  hitPoint: { lat: number; lon: number },
  hitUnitId: string,
  status: 'hit' | 'duded' = 'hit',
): TorpedoTrack {
  const priorPath = prior.path?.length
    ? prior.path
    : [
        {
          lat: (prior.launchPosition ?? before).lat,
          lon: (prior.launchPosition ?? before).lon,
        },
      ];
  const traveledM = horizontalMissMeters(before, hitPoint);
  const remainingRunNm = Math.max(0, prior.remainingRunNm - traveledM / METERS_PER_NM);
  return {
    ...advanced,
    status,
    hitUnitId,
    position: { lat: hitPoint.lat, lon: hitPoint.lon, depth: advanced.runDepthM },
    remainingRunNm,
    path: appendPathPoint(priorPath, { lat: hitPoint.lat, lon: hitPoint.lon }),
  };
}

export function isTorpedoTarget(unit: UnitState): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type === 'Aircraft') return false;
  if (unit.type === 'Submarine' && unit.position.depth > RADAR_SURFACE_DEPTH_M) {
    return false;
  }
  return true;
}

export function isDepthChargeTarget(unit: UnitState): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type !== 'Submarine') return false;
  return unit.position.depth > RADAR_SURFACE_DEPTH_M;
}

/** Surface ships + surfaced/awash subs — deck gun cannot usefully engage submerged boats. */
export function isDeckGunTarget(unit: UnitState): boolean {
  return isTorpedoTarget(unit);
}

export function clampDeckGunRangeNm(rangeNm: number): number {
  return clamp(Number(rangeNm) || 0, 0, DECK_GUN_MAX_RANGE_NM);
}

export function normalizeDeckGunFireOrder(raw: DeckGunFireOrder): DeckGunFireOrder {
  const shotRaw = raw.shotCount;
  const shotCount =
    shotRaw === undefined || shotRaw === null
      ? undefined
      : Math.max(1, Math.floor(Number(shotRaw) || 1));
  return {
    aimHeading: normalizeHeading(raw.aimHeading),
    estimatedCourse: normalizeHeading(raw.estimatedCourse),
    estimatedSpeedKn: Math.max(0, Number(raw.estimatedSpeedKn) || 0),
    estimatedRangeNm: Math.max(0, Number(raw.estimatedRangeNm) || 0),
    ...(shotCount !== undefined ? { shotCount } : {}),
  };
}

export function buildDeckGunFireBlock(
  turnNumber: number,
  depthM: number,
): DeckGunFireBlock {
  return {
    turnNumber,
    reason: 'submerged',
    depthM: Math.max(0, Number(depthM) || 0),
  };
}

export function formatDeckGunFireBlockNotice(block: DeckGunFireBlock): string {
  const depth = Math.round(block.depthM);
  return (
    `Turn ${block.turnNumber}: Deck gun did not fire — boat at ${depth} m ` +
    `(must be surfaced / awash ≤ ${RADAR_SURFACE_DEPTH_M} m). No shell expended.`
  );
}

export function deckGunMissBand(missM: number): 'near' | 'far' {
  return Math.max(0, missM) <= DECK_GUN_NEAR_MISS_M ? 'near' : 'far';
}

/**
 * Hit gate from true hull breadth × aspect (no length-ID scale — gun fire
 * does not use recognition-manual length the way torpedoes do).
 */
export function deckGunHitGateM(lengthM: number, beamM: number, aspectDeg: number): number {
  const half = torpedoHullHalfBreadthM(lengthM, beamM, aspectDeg);
  return Math.min(DECK_GUN_HIT_GATE_MAX_M, half + DECK_GUN_HIT_GATE_PAD_M);
}

/**
 * Compute fire heading + impact point from the player's entered solution.
 * Impact lies along the fire heading at the clamped estimated range (nm).
 * Shell TOF uses {@link DECK_GUN_SHELL_SPEED_KN} for intercept lead only.
 */
export function deckGunImpactFromSolution(opts: {
  firerPosition: LatLonDepth;
  aimHeading: number;
  estimatedCourse: number;
  estimatedSpeedKn: number;
  estimatedRangeNm: number;
}): {
  fireHeading: number;
  impact: LatLonDepth;
  rangeNm: number;
  interceptSec: number;
  solvable: boolean;
} {
  const rangeNm = clampDeckGunRangeNm(opts.estimatedRangeNm);
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: opts.aimHeading,
    estimatedCourse: opts.estimatedCourse,
    estimatedSpeedKn: opts.estimatedSpeedKn,
    estimatedRangeNm: rangeNm,
    torpedoSpeedKn: DECK_GUN_SHELL_SPEED_KN,
  });
  const fireHeading = solution.fireHeading;
  const impact = moveAlongHeading(
    { ...opts.firerPosition, depth: 0 },
    fireHeading,
    rangeNm * METERS_PER_NM,
  );
  return {
    fireHeading,
    impact: { ...impact, depth: 0 },
    rangeNm,
    interceptSec: solution.interceptSec,
    solvable: solution.solvable,
  };
}

export type DeckGunResolveInput = {
  firer: UnitState;
  fire: DeckGunFireOrder;
  contacts: UnitState[];
  /** Pre-kinematics positions for contact interpolation (optional). */
  startPositions?: ReadonlyMap<string, LatLonDepth>;
  turnLengthSeconds: number;
  seed: string;
  /**
   * Fraction of the turn [0, 1] when this round leaves the muzzle.
   * Contact interpolation uses fireFrac + shell-TOF/turn (clamped). Default 0.
   */
  fireTurnFraction?: number;
};

export type DeckGunResolveResult = {
  outcome: 'hit' | 'miss' | 'out_of_range';
  fireHeading: number;
  impact: LatLonDepth;
  rangeNm: number;
  damage: number;
  missDistanceM: number;
  hitUnitId?: string;
  closestApproachUnitId?: string;
  closestApproachUnitName?: string;
};

/**
 * Same-turn deck-gun resolution: impact from solution vs surface contacts.
 * Nearest eligible contact within its aspect gate scores a hit; otherwise miss
 * with CPA to the nearest surface hull (AAR / combat log).
 */
export function resolveDeckGunShot(input: DeckGunResolveInput): DeckGunResolveResult {
  const fire = normalizeDeckGunFireOrder(input.fire);
  const ballistics = deckGunImpactFromSolution({
    firerPosition: input.firer.position,
    aimHeading: fire.aimHeading,
    estimatedCourse: fire.estimatedCourse,
    estimatedSpeedKn: fire.estimatedSpeedKn,
    estimatedRangeNm: fire.estimatedRangeNm,
  });

  if (!(fire.estimatedRangeNm > 0)) {
    return {
      outcome: 'out_of_range',
      fireHeading: ballistics.fireHeading,
      impact: ballistics.impact,
      rangeNm: ballistics.rangeNm,
      damage: 0,
      missDistanceM: Number.POSITIVE_INFINITY,
    };
  }

  const turnSec = Math.max(1, Number(input.turnLengthSeconds) || 180);
  const fireFrac = clamp(Number(input.fireTurnFraction) || 0, 0, 1);
  const flightT = clamp(fireFrac + ballistics.interceptSec / turnSec, 0, 1);

  let bestMiss = Number.POSITIVE_INFINITY;
  let bestId: string | undefined;
  let bestName: string | undefined;
  let hitId: string | undefined;
  let hitMiss = Number.POSITIVE_INFINITY;

  for (const contact of input.contacts) {
    if (contact.id === input.firer.id) continue;
    if (!isDeckGunTarget(contact)) continue;
    const start = input.startPositions?.get(contact.id) ?? contact.position;
    const end = contact.position;
    const atFlight = lerpLatLonDepth(start, end, flightT);
    const miss = horizontalMissMeters(ballistics.impact, atFlight);
    if (miss < bestMiss) {
      bestMiss = miss;
      bestId = contact.id;
      bestName = contact.name;
    }
    const { lengthM, beamM } = unitLengthBeam(contact);
    const aspect = torpedoAspectAngleDeg(ballistics.fireHeading, contact.heading);
    const gate = deckGunHitGateM(lengthM, beamM, aspect);
    if (miss <= gate && miss < hitMiss) {
      hitMiss = miss;
      hitId = contact.id;
    }
  }

  if (hitId) {
    return {
      outcome: 'hit',
      fireHeading: ballistics.fireHeading,
      impact: ballistics.impact,
      rangeNm: ballistics.rangeNm,
      damage: DECK_GUN_HIT_DAMAGE,
      missDistanceM: hitMiss,
      hitUnitId: hitId,
      closestApproachUnitId: bestId,
      closestApproachUnitName: bestName,
    };
  }

  return {
    outcome: bestId ? 'miss' : 'miss',
    fireHeading: ballistics.fireHeading,
    impact: ballistics.impact,
    rangeNm: ballistics.rangeNm,
    damage: 0,
    missDistanceM: Number.isFinite(bestMiss) ? bestMiss : Number.POSITIVE_INFINITY,
    closestApproachUnitId: bestId,
    closestApproachUnitName: bestName,
  };
}

// --- Aircraft attack runs (umpire intercept / strafe / bombing) ---


/** Horizontal CPA (m) for a solid gun/bomb effect. */
export const AIRCRAFT_ATTACK_HIT_M = 280;
/** Horizontal CPA (m) for near-miss / light bombing splash. */
export const AIRCRAFT_ATTACK_NEAR_M = 900;
/** Beyond this CPA the run is out of reach this turn (far miss). */
export const AIRCRAFT_ATTACK_FAR_M = 2200;

/** Strafe / intercept gun damage (museum-scale). */
export const AIRCRAFT_INTERCEPT_DAMAGE = 14;
/** Explicit gun-strafe alias (same museum HP as intercept). */
export const AIRCRAFT_STRAFE_DAMAGE = AIRCRAFT_INTERCEPT_DAMAGE;
/** Bombing-run solid hit damage. */
export const AIRCRAFT_BOMBING_DAMAGE = 28;
/** Bombing near-miss splash / concussion. */
export const AIRCRAFT_BOMBING_NEAR_DAMAGE = 8;

/**
 * Guns / intercept / strafe: only effective vs surface ships and subs at / above PD
 * ({@link PERISCOPE_DEPTH_M}). Deeper boats are underwater — ineffective.
 */
export const AIRCRAFT_INTERCEPT_MAX_TARGET_DEPTH_M = PERISCOPE_DEPTH_M;

/**
 * Bombs lose effect past this keel depth (museum stub — not full ASW bombs).
 */
export const AIRCRAFT_BOMBING_EFFECTIVE_DEPTH_M = 60;

export function canOrderAircraftAttack(
  unit: Pick<UnitState, 'type' | 'condition'>,
): boolean {
  return unit.type === 'Aircraft' && unit.condition !== 'sunk';
}

/**
 * Class-appropriate attack buttons: fighters lead with intercept; bombers with
 * bombing run. Strafe (guns) is always listed; does not consume the bomb.
 */
export function aircraftAttackModesForClass(hullClass: HullClass): AircraftAttackMode[] {
  if (hullClass === 'Bomber') return ['bombing_run', 'strafe', 'intercept'];
  return ['intercept', 'strafe', 'bombing_run'];
}

export function isAircraftAttackTarget(
  unit: Pick<UnitState, 'type' | 'condition'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type === 'Aircraft') return false;
  return true;
}

export function normalizeAircraftAttackMode(raw: unknown): AircraftAttackMode {
  if (raw === 'bombing_run') return 'bombing_run';
  if (raw === 'strafe') return 'strafe';
  return 'intercept';
}

/** True when the mode uses guns (no bomb expenditure). */
export function isAircraftGunAttackMode(mode: AircraftAttackMode): boolean {
  return mode === 'intercept' || mode === 'strafe';
}

export type AircraftAttackEffectInput = {
  mode: AircraftAttackMode;
  missDistanceM: number;
  targetDepthM: number;
  targetType: VesselType;
  seed: string;
};

export type AircraftAttackOutcome = 'hit' | 'near_miss' | 'far_miss' | 'ineffective';

/**
 * Aircraft attack effect from horizontal CPA + depth eligibility.
 * Deterministic seed (same pattern as depth charges) for museum replay.
 * Intercept and strafe share gun rules / damage; bombing uses the bomb table.
 */
export function resolveAircraftAttackEffect(input: AircraftAttackEffectInput): {
  damage: number;
  outcome: AircraftAttackOutcome;
  effectPct: number;
} {
  const miss = Math.max(0, Number(input.missDistanceM) || 0);
  const depth = Math.max(0, Number(input.targetDepthM) || 0);
  const mode = normalizeAircraftAttackMode(input.mode);
  const guns = isAircraftGunAttackMode(mode);

  if (guns && input.targetType === 'Submarine' && depth > AIRCRAFT_INTERCEPT_MAX_TARGET_DEPTH_M) {
    return { damage: 0, outcome: 'ineffective', effectPct: 0 };
  }
  if (
    mode === 'bombing_run' &&
    input.targetType === 'Submarine' &&
    depth > AIRCRAFT_BOMBING_EFFECTIVE_DEPTH_M
  ) {
    return { damage: 0, outcome: 'ineffective', effectPct: 0 };
  }

  if (miss > AIRCRAFT_ATTACK_FAR_M) {
    return { damage: 0, outcome: 'far_miss', effectPct: 0 };
  }
  if (miss > AIRCRAFT_ATTACK_NEAR_M) {
    return { damage: 0, outcome: 'near_miss', effectPct: 8 };
  }

  const close = miss <= AIRCRAFT_ATTACK_HIT_M;
  let effectPct =
    mode === 'bombing_run'
      ? close
        ? 62
        : 28
      : close
        ? 72
        : 32;

  // Deepish sub under bombs: softer hit chance.
  if (
    mode === 'bombing_run' &&
    input.targetType === 'Submarine' &&
    depth > RADAR_SURFACE_DEPTH_M
  ) {
    effectPct = Math.round(effectPct * 0.65);
  }

  const roll = weaponRng01(input.seed) * 100;
  if (roll >= effectPct) {
    return { damage: 0, outcome: 'near_miss', effectPct };
  }

  if (mode === 'bombing_run') {
    const damage = close ? AIRCRAFT_BOMBING_DAMAGE : AIRCRAFT_BOMBING_NEAR_DAMAGE;
    return { damage, outcome: 'hit', effectPct };
  }
  // Guns (intercept / strafe): solid only on close pass; outer band is near-miss / tracers.
  if (!close) {
    return { damage: 0, outcome: 'near_miss', effectPct };
  }
  return {
    damage: mode === 'strafe' ? AIRCRAFT_STRAFE_DAMAGE : AIRCRAFT_INTERCEPT_DAMAGE,
    outcome: 'hit',
    effectPct,
  };
}

/**
 * CPA of this turn's aircraft path vs the target's simultaneous interpolated track.
 * `t` is the fraction along the aircraft segment where closest approach occurs.
 */
export function aircraftAttackClosestApproach(opts: {
  aircraftStart: LatLonDepth;
  aircraftEnd: LatLonDepth;
  targetStart: LatLonDepth;
  targetEnd: LatLonDepth;
}): { missM: number; t: number; aircraftPoint: LatLonDepth; targetPoint: LatLonDepth } {
  const { east: te0, north: tn0 } = eastNorthMeters(opts.aircraftStart, opts.targetStart);
  const { east: te1, north: tn1 } = eastNorthMeters(opts.aircraftStart, opts.targetEnd);
  const { east: se, north: sn } = eastNorthMeters(opts.aircraftStart, opts.aircraftEnd);
  const segLen2 = se * se + sn * sn;
  let bestT = 0;
  let bestMiss = Number.POSITIVE_INFINITY;
  // Coarse sample along the turn (aircraft + target both interpolate).
  const samples = 12;
  for (let i = 0; i <= samples; i++) {
    const ft = i / samples;
    const ax = se * ft;
    const ay = sn * ft;
    const tx = te0 + (te1 - te0) * ft;
    const ty = tn0 + (tn1 - tn0) * ft;
    const miss = Math.hypot(ax - tx, ay - ty);
    if (miss < bestMiss) {
      bestMiss = miss;
      bestT = ft;
    }
  }
  if (segLen2 < 1e-6 && !(bestMiss < Number.POSITIVE_INFINITY)) {
    bestMiss = Math.hypot(te0, tn0);
    bestT = 0;
  }
  const aircraftPoint = {
    lat: opts.aircraftStart.lat + (opts.aircraftEnd.lat - opts.aircraftStart.lat) * bestT,
    lon: opts.aircraftStart.lon + (opts.aircraftEnd.lon - opts.aircraftStart.lon) * bestT,
    depth: 0,
  };
  const targetPoint = {
    lat: opts.targetStart.lat + (opts.targetEnd.lat - opts.targetStart.lat) * bestT,
    lon: opts.targetStart.lon + (opts.targetEnd.lon - opts.targetStart.lon) * bestT,
    depth: opts.targetStart.depth + (opts.targetEnd.depth - opts.targetStart.depth) * bestT,
  };
  return {
    missM: bestMiss,
    t: bestT,
    aircraftPoint,
    targetPoint,
  };
}

export function formatAircraftAttackModeLabel(mode: AircraftAttackMode): string {
  if (mode === 'bombing_run') return 'bombing run';
  if (mode === 'strafe') return 'strafe';
  return 'intercept';
}

/**
 * HP actually removed by {@link applyHealthDamage} (0 when already sunk / no-op).
 * Combat-log `damage` and Controls staging must use this — not the rolled effect —
 * so overkill / finishing blows do not report more HP than the bar can drop.
 *
 * Casualty rolls live in {@link ./damage.js} (`applyHealthDamage` /
 * `applyHealthDamageResult`).
 */
export function healthDamageApplied(before: UnitState, after: UnitState): number {
  return Math.max(0, before.health - after.health);
}

/**
 * Controls Damage-tab presentation HP while some own-damage lines are still
 * waiting on blast cues: add unrevealed applied HP back onto resolve-truth.
 */
export function presentationHealthFromUnrevealedDamage(
  resolvedHealth: number,
  unrevealed: ReadonlyArray<{ kind: string; damage?: number }>,
): number {
  let addBack = 0;
  for (const e of unrevealed) {
    if (
      (e.kind === 'depth_charge_damage' ||
        e.kind === 'torpedo_hit' ||
        e.kind === 'aircraft_attack_damage' ||
        e.kind === 'deck_gun_hit') &&
      e.damage != null &&
      e.damage > 0
    ) {
      addBack += e.damage;
    }
  }
  return Math.min(100, Math.max(0, resolvedHealth + addBack));
}

/**
 * Build FoW-safe own-ship damage lines from the umpire combat log.
 * Only events that targeted this hull; summaries omit enemy GT identity.
 */
export function buildOwnDamageLog(
  unitId: string,
  combatLog: CombatLogEntry[] | undefined,
): OwnDamageEvent[] {
  const out: OwnDamageEvent[] = [];
  for (const e of combatLog ?? []) {
    if (e.targetUnitId !== unitId) continue;
    if (
      e.kind !== 'torpedo_hit' &&
      e.kind !== 'depth_charge_damage' &&
      e.kind !== 'aircraft_attack_damage' &&
      e.kind !== 'deck_gun_hit' &&
      e.kind !== 'unit_sunk' &&
      e.kind !== 'hull_implosion' &&
      e.kind !== 'subsystem_casualty'
    ) {
      continue;
    }
    let summary: string;
    switch (e.kind) {
      case 'torpedo_hit':
        summary =
          e.damage != null ? `Torpedo hit — −${e.damage} HP` : 'Torpedo hit';
        break;
      case 'depth_charge_damage':
        summary =
          e.damage != null
            ? `Depth-charge shock — −${e.damage} HP`
            : 'Depth-charge shock';
        break;
      case 'aircraft_attack_damage':
        summary =
          e.damage != null
            ? `Air attack — −${e.damage} HP`
            : 'Air attack';
        break;
      case 'deck_gun_hit':
        summary =
          e.damage != null ? `Deck-gun hit — −${e.damage} HP` : 'Deck-gun hit';
        break;
      case 'unit_sunk':
        summary = 'Hull lost — sunk / destroyed';
        break;
      case 'hull_implosion':
        summary = 'Hull imploded — crushed by pressure';
        break;
      case 'subsystem_casualty':
        summary = e.summary;
        break;
      default:
        summary = e.summary;
    }
    out.push({
      id: e.id,
      kind: e.kind,
      turnNumber: e.turnNumber,
      gameTimeSeconds: e.gameTimeSeconds,
      summary,
      damage: e.damage,
      ...(e.sourceDetonationId ? { sourceDetonationId: e.sourceDetonationId } : {}),
      ...(e.casualtyEffect ? { casualtyEffect: e.casualtyEffect } : {}),
    });
  }
  return out;
}

export function unitLengthBeam(unit: UnitState): { lengthM: number; beamM: number } {
  return {
    lengthM: resolveLengthM({ lengthM: unit.lengthM, class: unit.class, type: unit.type }),
    beamM: resolveBeamM({ beamM: unit.beamM, class: unit.class, type: unit.type }),
  };
}

/**
 * Wall-clock delay (seconds) from turn resolve until a torpedo-hit explosion
 * should be heard (and the matching Damage-tab line revealed).
 *
 * The fish is advanced in {@link WEAPON_SUBSTEPS} slices of the turn;
 * `stepIndex` is the slice that scored the hit and `segmentT` is the fraction
 * along that slice (0 = start, 1 = end) where the track met the target.
 *
 * **Compression rule:** relative arrival within the turn is preserved, then
 * scaled into `min(turnLengthSeconds, {@link TORPEDO_HIT_AUDIO_MAX_DELAY_SEC})`
 * so a hit at fraction `f` of a 180 s turn plays at `f × 90` s, not `f × 180` s.
 * Turns shorter than the cap are unchanged. This delay is presentation-only —
 * kinematics, GT tracks, and umpire logs use the real resolve timing.
 */
export function torpedoHitAudioDelaySec(
  stepIndex: number,
  segmentT: number,
  turnLengthSeconds: number,
): number {
  const steps = WEAPON_SUBSTEPS;
  if (!(steps > 0)) return 0;
  const step = Math.max(0, Math.min(steps - 1, Math.floor(stepIndex)));
  const t = Math.max(0, Math.min(1, Number.isFinite(segmentT) ? segmentT : 0));
  const turn = Math.max(0, Number.isFinite(turnLengthSeconds) ? turnLengthSeconds : 0);
  const windowSec = Math.min(turn, TORPEDO_HIT_AUDIO_MAX_DELAY_SEC);
  return ((step + t) / steps) * windowSec;
}

export function makeDetonationEvent(opts: {
  id: string;
  kind?:
    | 'depth_charge'
    | 'torpedo_hit'
    | 'aircraft_bomb'
    | 'deck_gun_fire'
    | 'deck_gun_hit';
  position: LatLonDepth;
  turnNumber: number;
  firerUnitId: string;
  targetUnitId?: string;
  audioDelaySec?: number;
}): WeaponDetonationEvent {
  const delay = opts.audioDelaySec;
  return {
    id: opts.id,
    kind: opts.kind ?? 'depth_charge',
    position: { ...opts.position },
    turnNumber: opts.turnNumber,
    firerUnitId: opts.firerUnitId,
    ...(opts.targetUnitId ? { targetUnitId: opts.targetUnitId } : {}),
    ...(delay != null && delay > 0 ? { audioDelaySec: delay } : {}),
  };
}

/** Controls gain falloff for torpedo-hit cues (0–1). Soft inverse-square-ish. */
export function torpedoHitControlsGain(rangeNm: number): number {
  const r = Math.max(0, rangeNm);
  const r0 = TORPEDO_HIT_CONTROLS_REF_NM;
  return 1 / (1 + (r / r0) * (r / r0));
}

export { bearingRangeNm };
