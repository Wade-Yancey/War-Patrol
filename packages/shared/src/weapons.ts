/**
 * Torpedo + depth-charge combat model (v1).
 *
 * Hit resolution is RNG with geometric gates + additive identification
 * modifiers — not continuous hydrodynamic physics.
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
 * Horizontal miss distance (m) inside which a hit roll is attempted.
 * Outside this gate the fish misses geometrically (no RNG).
 */
export const TORPEDO_HIT_GATE_M = 90;

/** Damage applied on a successful torpedo hit (health points). */
export const TORPEDO_HIT_DAMAGE = 45;

/**
 * Aspect → base hit % (track angle off target's bow-stern axis).
 * 90° = full beam (best); 0° = end-on (worst). Interpolate between knots.
 */
export const TORPEDO_ASPECT_BASE_TABLE: ReadonlyArray<{ angleDeg: number; hitPct: number }> = [
  { angleDeg: 0, hitPct: 5 },
  { angleDeg: 15, hitPct: 10 },
  { angleDeg: 45, hitPct: 25 },
  { angleDeg: 90, hitPct: 50 },
];

/** Additive % when estimated length is within tolerance of truth. */
export const TORPEDO_MOD_LENGTH_ACCURATE_PCT = 10;

/** Additive % when estimated speed is within tolerance of truth. */
export const TORPEDO_MOD_SPEED_ACCURATE_PCT = 10;

/**
 * Length estimate is "accurate" when |est − truth| / truth ≤ this fraction
 * (or absolute ≤ TORPEDO_LENGTH_ABS_TOL_M for short hulls).
 */
export const TORPEDO_LENGTH_REL_TOL = 0.15;

/** Absolute length tolerance (m) floor — e.g. ±12 m. */
export const TORPEDO_LENGTH_ABS_TOL_M = 12;

/**
 * Speed estimate is "accurate" when |est − truth| ≤ this many knots.
 */
export const TORPEDO_SPEED_ABS_TOL_KN = 2;

/**
 * Max range (nm) for Controls torpedo-hit explosion cue attenuation.
 * Firer and target always get a cue when they are the involved units;
 * gain falls off with distance to the hit point.
 */
export const TORPEDO_HIT_CONTROLS_REF_NM = 4;

// --- Depth charges (DD rack / thrower stub) ---

/** Approximate sink rate (m/s) — ~10–15 ft/s order of magnitude. */
export const DEPTH_CHARGE_SINK_MPS = 3.5;

export const DEPTH_CHARGE_DEFAULT_DEPTH_M = 50;
export const DEPTH_CHARGE_MIN_DEPTH_M = 15;
export const DEPTH_CHARGE_MAX_DEPTH_M = 90;

/** Fletcher-class ready rack load for demo. */
export const DESTROYER_DEPTH_CHARGE_LOAD = 12;

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

/** Horizontal range bands (m) for additive range modifiers. */
export const DEPTH_CHARGE_RANGE_CLOSE_M = 25;
export const DEPTH_CHARGE_RANGE_MED_M = 55;
export const DEPTH_CHARGE_RANGE_FAR_M = 90;

export const DEPTH_CHARGE_MOD_RANGE_CLOSE_PCT = 15;
export const DEPTH_CHARGE_MOD_RANGE_MED_PCT = 0;
export const DEPTH_CHARGE_MOD_RANGE_FAR_PCT = -20;
export const DEPTH_CHARGE_MOD_RANGE_OUT_PCT = -100;

/** Pattern discipline bonus (tight diamond vs hurried single). */
export const DEPTH_CHARGE_MOD_PATTERN: Record<DepthChargePattern, number> = {
  single: 0,
  pair: 5,
  pattern_3: 8,
  pattern_5: 10,
};

export const DEPTH_CHARGE_LETHAL_DAMAGE = 55;
export const DEPTH_CHARGE_DAMAGE_AMOUNT = 22;
export const DEPTH_CHARGE_STUN_DAMAGE = 8;

/**
 * Pattern → thrower lateral offsets (m, + = starboard of track heading).
 * Along-track spacing uses {@link depthChargeReleaseFractions} on the firer's
 * start→end move — charges trail along the path, not a single midpoint pile.
 */
export const DEPTH_CHARGE_PATTERN_LATERAL_M: Record<
  DepthChargePattern,
  ReadonlyArray<number>
> = {
  single: [0],
  pair: [-28, 28],
  pattern_3: [-35, 0, 35],
  pattern_5: [-40, 22, -22, 40, 0],
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
    { aheadM: -20, lateralM: -28 },
    { aheadM: -55, lateralM: 28 },
  ],
  pattern_3: [
    { aheadM: -15, lateralM: -35 },
    { aheadM: -45, lateralM: 0 },
    { aheadM: -75, lateralM: 35 },
  ],
  pattern_5: [
    { aheadM: -10, lateralM: -40 },
    { aheadM: -30, lateralM: 22 },
    { aheadM: -50, lateralM: -22 },
    { aheadM: -70, lateralM: 40 },
    { aheadM: -90, lateralM: 0 },
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
/** Controls bridge speakers — any vessel this close to a blast hears it. */
export const DEPTH_CHARGE_CONTROLS_AUDIBLE_NM = 0.6;

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
 * True headings for a fan centered on `aimHeading`.
 * Odd counts put one fish on the aim axis; even counts straddle it.
 */
export function torpedoSpreadHeadings(
  aimHeading: number,
  count: number,
  spreadDeg: number,
): number[] {
  const n = clampTorpedoSpreadCount(count);
  const spacing = clampTorpedoSpreadDeg(spreadDeg);
  if (n <= 1) return [normalizeHeading(aimHeading)];
  const start = aimHeading - ((n - 1) / 2) * spacing;
  return Array.from({ length: n }, (_, i) => normalizeHeading(start + i * spacing));
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
 * Interpolate base hit % from the aspect table.
 * Angle is track-vs-bow/stern axis in [0, 90]°.
 */
export function torpedoBaseHitPctFromAspect(aspectDeg: number): number {
  const a = clamp(aspectDeg, 0, 90);
  const table = TORPEDO_ASPECT_BASE_TABLE;
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i]!;
    const hi = table[i + 1]!;
    if (a >= lo.angleDeg && a <= hi.angleDeg) {
      const t = (a - lo.angleDeg) / (hi.angleDeg - lo.angleDeg || 1);
      return lo.hitPct + t * (hi.hitPct - lo.hitPct);
    }
  }
  return table[table.length - 1]!.hitPct;
}

/** True when player length estimate is within documented tolerance of truth. */
export function isLengthAccuratelyIdentified(
  estimatedLengthM: number,
  trueLengthM: number,
): boolean {
  if (!Number.isFinite(estimatedLengthM) || estimatedLengthM <= 0) return false;
  if (!Number.isFinite(trueLengthM) || trueLengthM <= 0) return false;
  const err = Math.abs(estimatedLengthM - trueLengthM);
  const tol = Math.max(TORPEDO_LENGTH_ABS_TOL_M, trueLengthM * TORPEDO_LENGTH_REL_TOL);
  return err <= tol;
}

/** True when player speed estimate is within ±TORPEDO_SPEED_ABS_TOL_KN of |truth|. */
export function isSpeedAccuratelyIdentified(
  estimatedSpeedKn: number,
  trueSpeedKn: number,
): boolean {
  if (!Number.isFinite(estimatedSpeedKn) || estimatedSpeedKn < 0) return false;
  return Math.abs(estimatedSpeedKn - Math.abs(trueSpeedKn)) <= TORPEDO_SPEED_ABS_TOL_KN;
}

export type TorpedoHitRollInput = {
  /** Geometric miss distance at closest approach (m). */
  missDistanceM: number;
  fishHeading: number;
  targetHeading: number;
  /** True target length (sim) — never shown to players. */
  trueLengthM: number;
  /** True |speed| (sim). */
  trueSpeedKn: number;
  /** Player calculator estimate (m). */
  estimatedLengthM: number;
  /** Player calculator estimate (kn). */
  estimatedSpeedKn: number;
  /** Fish run depth vs target keel — surface targets need shallow fish. */
  depthOk: boolean;
  seed: string;
};

export type TorpedoHitRollResult = {
  hit: boolean;
  hitPct: number;
  basePct: number;
  aspectDeg: number;
  lengthAccurate: boolean;
  speedAccurate: boolean;
  geometricMiss: boolean;
};

/**
 * Resolve one fish vs one target: geometric gate, then aspect base + additive mods.
 * Final hit % clamped to [0, 95] (never quite certain).
 */
export function resolveTorpedoHit(input: TorpedoHitRollInput): TorpedoHitRollResult {
  const aspectDeg = torpedoAspectAngleDeg(input.fishHeading, input.targetHeading);
  const basePct = torpedoBaseHitPctFromAspect(aspectDeg);
  const lengthAccurate = isLengthAccuratelyIdentified(
    input.estimatedLengthM,
    input.trueLengthM,
  );
  const speedAccurate = isSpeedAccuratelyIdentified(
    input.estimatedSpeedKn,
    input.trueSpeedKn,
  );

  if (!input.depthOk || input.missDistanceM > TORPEDO_HIT_GATE_M) {
    return {
      hit: false,
      hitPct: 0,
      basePct,
      aspectDeg,
      lengthAccurate,
      speedAccurate,
      geometricMiss: true,
    };
  }

  let hitPct = basePct;
  if (lengthAccurate) hitPct += TORPEDO_MOD_LENGTH_ACCURATE_PCT;
  if (speedAccurate) hitPct += TORPEDO_MOD_SPEED_ACCURATE_PCT;
  hitPct = clamp(hitPct, 0, 95);

  const roll = weaponRng01(input.seed) * 100;
  return {
    hit: roll < hitPct,
    hitPct,
    basePct,
    aspectDeg,
    lengthAccurate,
    speedAccurate,
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
  estimatedLengthM: number;
  estimatedSpeedKn: number;
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
    estimatedLengthM: opts.estimatedLengthM,
    estimatedSpeedKn: opts.estimatedSpeedKn,
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

/**
 * Snap a fish track to the hit point on its last advance segment and truncate
 * the GT path so the trail ends at the collision (does not continue past).
 */
export function truncateTorpedoAtHit(
  prior: TorpedoTrack,
  advanced: TorpedoTrack,
  before: LatLonDepth,
  hitPoint: { lat: number; lon: number },
  hitUnitId: string,
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
    status: 'hit',
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

/** Health below this → sensors subsystem disabled (combat damage cascade). */
export const HEALTH_SENSORS_DISABLED_BELOW = 70;

/** Health below this → propulsion subsystem disabled (combat damage cascade). */
export const HEALTH_PROPULSION_DISABLED_BELOW = 35;

export function applyHealthDamage(unit: UnitState, damage: number): UnitState {
  if (damage <= 0 || unit.condition === 'sunk') return unit;
  const health = Math.max(0, unit.health - damage);
  if (health <= 0) {
    return {
      ...unit,
      health: 0,
      condition: 'sunk',
      speed: 0,
      eot: 'stop',
      activeSonarEnabled: false,
      subsystems: { propulsion: 'disabled', sensors: 'disabled' },
    };
  }

  const subsystems = { ...unit.subsystems };
  if (health < HEALTH_SENSORS_DISABLED_BELOW) subsystems.sensors = 'disabled';
  if (health < HEALTH_PROPULSION_DISABLED_BELOW) subsystems.propulsion = 'disabled';

  const propulsionOut = subsystems.propulsion === 'disabled';
  const sensorsOut = subsystems.sensors === 'disabled';
  return {
    ...unit,
    health,
    subsystems,
    speed: propulsionOut ? 0 : unit.speed,
    eot: propulsionOut ? 'stop' : unit.eot,
    activeSonarEnabled: sensorsOut ? false : unit.activeSonarEnabled,
  };
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

export function makeDetonationEvent(opts: {
  id: string;
  kind?: 'depth_charge' | 'torpedo_hit';
  position: LatLonDepth;
  turnNumber: number;
  firerUnitId: string;
  targetUnitId?: string;
}): WeaponDetonationEvent {
  return {
    id: opts.id,
    kind: opts.kind ?? 'depth_charge',
    position: { ...opts.position },
    turnNumber: opts.turnNumber,
    firerUnitId: opts.firerUnitId,
    ...(opts.targetUnitId ? { targetUnitId: opts.targetUnitId } : {}),
  };
}

/** Controls gain falloff for torpedo-hit cues (0–1). Soft inverse-square-ish. */
export function torpedoHitControlsGain(rangeNm: number): number {
  const r = Math.max(0, rangeNm);
  const r0 = TORPEDO_HIT_CONTROLS_REF_NM;
  return 1 / (1 + (r / r0) * (r / r0));
}

export { bearingRangeNm };
