/**
 * Torpedo + depth-charge combat model (v1).
 *
 * Torpedo hits are geometry-first: closest approach within a hull-breadth
 * gate using real length/beam, then scaled by how accurately the operator
 * identified target length (recognition manual). Aspect softens damage and
 * adds a small warhead dud chance — not the old 5–50% “did you hit” RNG table.
 * Fire headings come from the player's entered TDC solution (aim + course /
 * speed / range intercept) — never auto-filled from sim truth.
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
  moveAlongHeading,
  normalizeHeading,
} from './geo.js';
import type {
  CombatLogEntry,
  DepthChargePattern,
  DepthChargeTrack,
  LatLonDepth,
  OwnDamageEvent,
  TorpedoTrack,
  UnitState,
  WeaponDetonationEvent,
} from './types.js';
import { resolveBeamM, resolveLengthM } from './dimensions.js';

// --- Torpedo (Mk 14–ish fleet-sub fish) ---

/** High-speed setting ~46 kn. */
export const TORPEDO_SPEED_KN = 46;

/** Max run at high-speed setting (~9,000 yd ≈ 4.5 nm). */
export const TORPEDO_MAX_RUN_NM = 4.5;

/** Default run depth (m) — shallow anti-surface. */
export const TORPEDO_DEFAULT_DEPTH_M = 3;

export const TORPEDO_MIN_DEPTH_M = 1;
export const TORPEDO_MAX_DEPTH_M = 25;

/** Fleet-sub ready fish at scenario start (bow tubes only for v1). */
export const FLEET_SUB_TORPEDO_LOAD = 6;

/** Max fish in one queued spread order. */
export const TORPEDO_SPREAD_MAX_COUNT = 4;

/** Max angular spacing between adjacent fish in a spread (degrees). */
export const TORPEDO_SPREAD_MAX_DEG = 8;

/** Default inter-fish spacing when operator leaves spreadDeg unset. */
export const TORPEDO_SPREAD_DEFAULT_DEG = 2;

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
 * Tuning (ease sub hits): was 0.10 (±10%); now 0.15 (±15%) so small
 * recognition-manual rounding still keeps full chord.
 */
export const TORPEDO_LENGTH_ID_FULL_FRAC = 0.15;

/**
 * Length-ID zero credit: relative error at or above this collapses the
 * effective hit gate to 0 (wrong ID → miss even on geometric contact).
 *
 * Tuning (ease sub hits): was 0.40; now 0.50 so near-miss class picks
 * (e.g. cruiser for DD) still keep a partial gate instead of hard zero.
 */
export const TORPEDO_LENGTH_ID_ZERO_FRAC = 0.5;

/** Base damage applied on a successful (non-dud) torpedo hit (health points). */
export const TORPEDO_HIT_DAMAGE = 45;

/**
 * Aspect → warhead dud % (track angle off target's bow-stern axis).
 * 90° = full beam (lowest dud); 0° = end-on (highest dud). Interpolate.
 */
export const TORPEDO_ASPECT_DUD_TABLE: ReadonlyArray<{ angleDeg: number; dudPct: number }> = [
  { angleDeg: 0, dudPct: 18 },
  { angleDeg: 15, dudPct: 12 },
  { angleDeg: 45, dudPct: 6 },
  { angleDeg: 90, dudPct: 3 },
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

/** Fletcher-class ready rack load for demo (doubled from the original 12). */
export const DESTROYER_DEPTH_CHARGE_LOAD = 24;

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
  return Math.min(TORPEDO_SPREAD_MAX_DEG, n);
}

/**
 * True headings for a fan centered on `centerHeading` (usually the
 * solution-derived fire heading, not raw LOS aim).
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

export function defaultTorpedoLoad(unit: Pick<UnitState, 'class' | 'type'>): number {
  if (unit.class === 'Fleet Submarine' || unit.type === 'Submarine') {
    return FLEET_SUB_TORPEDO_LOAD;
  }
  return 0;
}

export function defaultDepthChargeLoad(unit: Pick<UnitState, 'class' | 'type'>): number {
  if (unit.class === 'Destroyer') return DESTROYER_DEPTH_CHARGE_LOAD;
  return 0;
}

export function canFireTorpedo(
  unit: Pick<UnitState, 'type' | 'class' | 'condition' | 'torpedoLoad'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.type !== 'Submarine' && unit.class !== 'Fleet Submarine') return false;
  return (unit.torpedoLoad ?? 0) > 0;
}

export function canDropDepthCharges(
  unit: Pick<UnitState, 'type' | 'class' | 'condition' | 'depthChargeLoad'>,
): boolean {
  if (unit.condition === 'sunk') return false;
  if (unit.class !== 'Destroyer') return false;
  return (unit.depthChargeLoad ?? 0) > 0;
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

/**
 * @deprecated Old RNG aspect→hit% table removed. Prefer {@link torpedoDudPctFromAspect}.
 * Returns a legacy-shaped value for any residual callers (beam ≈ 50).
 */
export function torpedoBaseHitPctFromAspect(aspectDeg: number): number {
  // Map inverse of dud table into a rough “legacy hit feel” for tests migrating off.
  const dud = torpedoDudPctFromAspect(aspectDeg);
  return clamp(100 - dud * 4, 5, 50);
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
      (e.kind === 'depth_charge_damage' || e.kind === 'torpedo_hit') &&
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
  kind?: 'depth_charge' | 'torpedo_hit';
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
