import {
  DEFAULT_TURN_LENGTH_SECONDS,
  KNOTS_TO_MPS,
  NOISEMAKER_COOLDOWN_TURNS,
  NOISEMAKER_COURSE_WANDER_DEG,
  NOISEMAKER_DRIFT_SPEED_MAX_KN,
  NOISEMAKER_DRIFT_SPEED_MIN_KN,
  NOISEMAKER_LIFETIME_TURNS,
  NOISEMAKER_SOURCE_LEVEL,
  NOISEMAKER_SPEED_WANDER_KN,
} from './constants.js';
import { clampSubmarineDepth } from './dive.js';
import { clamp, moveAlongHeading, normalizeHeading } from './geo.js';
import type { LatLonDepth, NoisemakerTrack, UnitState } from './types.js';

/** Clamp / coarse-snap a noisemaker deploy depth (same dial as Dive Plane). */
export function clampNoisemakerDepthM(depthM: number): number {
  return clampSubmarineDepth(depthM);
}

/** True when this hull may queue a noisemaker deploy (fleet sub, afloat, cooled down). */
export function canDeployNoisemaker(unit: Pick<UnitState, 'type' | 'condition' | 'noisemakerCooldownTurnsRemaining'>): boolean {
  if (unit.type !== 'Submarine') return false;
  if (unit.condition === 'sunk' || unit.condition === 'sinking') return false;
  return (unit.noisemakerCooldownTurnsRemaining ?? 0) <= 0;
}

function clampDriftSpeedKn(speedKn: number): number {
  return clamp(speedKn, NOISEMAKER_DRIFT_SPEED_MIN_KN, NOISEMAKER_DRIFT_SPEED_MAX_KN);
}

/** Uniform random in [min, max]. */
function randRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

/**
 * Assign initial heading + drift speed for a new decoy.
 * Heading is fully random; speed is uniform inside the drift band.
 */
export function rollNoisemakerMotion(rng: () => number = Math.random): {
  heading: number;
  speedKn: number;
} {
  return {
    heading: normalizeHeading(randRange(rng, 0, 360)),
    speedKn: clampDriftSpeedKn(
      randRange(rng, NOISEMAKER_DRIFT_SPEED_MIN_KN, NOISEMAKER_DRIFT_SPEED_MAX_KN),
    ),
  };
}

/** Fill missing heading/speed on legacy tracks (pre-drift saves). */
export function ensureNoisemakerMotion(
  track: NoisemakerTrack,
  rng: () => number = Math.random,
): NoisemakerTrack {
  const hasHeading = typeof track.heading === 'number' && Number.isFinite(track.heading);
  const hasSpeed = typeof track.speedKn === 'number' && Number.isFinite(track.speedKn);
  if (hasHeading && hasSpeed) {
    return {
      ...track,
      heading: normalizeHeading(track.heading),
      speedKn: clampDriftSpeedKn(track.speedKn),
    };
  }
  const rolled = rollNoisemakerMotion(rng);
  return {
    ...track,
    heading: hasHeading ? normalizeHeading(track.heading) : rolled.heading,
    speedKn: hasSpeed ? clampDriftSpeedKn(track.speedKn) : rolled.speedKn,
  };
}

/** Create a drifting noisemaker track at the sub's lat/lon and chosen depth. */
export function createNoisemakerTrack(opts: {
  id: string;
  deployerUnitId: string;
  position: LatLonDepth;
  deployedTurn: number;
  /** Optional fixed heading (tests); otherwise random. */
  heading?: number;
  /** Optional fixed speed kn (tests); otherwise random in drift band. */
  speedKn?: number;
  rng?: () => number;
}): NoisemakerTrack {
  const depth = clampNoisemakerDepthM(opts.position.depth);
  const rolled = rollNoisemakerMotion(opts.rng ?? Math.random);
  const heading =
    typeof opts.heading === 'number' && Number.isFinite(opts.heading)
      ? normalizeHeading(opts.heading)
      : rolled.heading;
  const speedKn =
    typeof opts.speedKn === 'number' && Number.isFinite(opts.speedKn)
      ? clampDriftSpeedKn(opts.speedKn)
      : rolled.speedKn;
  return {
    id: opts.id,
    deployerUnitId: opts.deployerUnitId,
    position: {
      lat: opts.position.lat,
      lon: opts.position.lon,
      depth,
    },
    heading,
    speedKn,
    deployedTurn: opts.deployedTurn,
    expiresTurn: opts.deployedTurn + NOISEMAKER_LIFETIME_TURNS,
    status: 'active',
  };
}

/** Tick cooldown after a resolve; clamps at 0. */
export function advanceNoisemakerCooldown(unit: UnitState): UnitState {
  const turns = Math.max(0, Math.floor(Number(unit.noisemakerCooldownTurnsRemaining) || 0));
  if (turns <= 0) {
    if ((unit.noisemakerCooldownTurnsRemaining ?? 0) === 0) return unit;
    return { ...unit, noisemakerCooldownTurnsRemaining: 0 };
  }
  return { ...unit, noisemakerCooldownTurnsRemaining: turns - 1 };
}

/** Start cooldown after a successful deploy. */
export function armNoisemakerCooldown(unit: UnitState): UnitState {
  return { ...unit, noisemakerCooldownTurnsRemaining: NOISEMAKER_COOLDOWN_TURNS };
}

/**
 * One resolve of slow random drift: wander course/speed, then advance lat/lon.
 * Depth is unchanged. Does not expire the track.
 */
export function driftNoisemakerTrack(
  track: NoisemakerTrack,
  turnLengthSeconds: number,
  rng: () => number = Math.random,
): NoisemakerTrack {
  const motion = ensureNoisemakerMotion(track, rng);
  const turnLen =
    typeof turnLengthSeconds === 'number' &&
    Number.isFinite(turnLengthSeconds) &&
    turnLengthSeconds > 0
      ? turnLengthSeconds
      : DEFAULT_TURN_LENGTH_SECONDS;

  const courseDelta = randRange(rng, -NOISEMAKER_COURSE_WANDER_DEG, NOISEMAKER_COURSE_WANDER_DEG);
  const speedDelta = randRange(rng, -NOISEMAKER_SPEED_WANDER_KN, NOISEMAKER_SPEED_WANDER_KN);
  const heading = normalizeHeading(motion.heading + courseDelta);
  const speedKn = clampDriftSpeedKn(motion.speedKn + speedDelta);
  const distanceM = speedKn * KNOTS_TO_MPS * turnLen;
  const position =
    distanceM > 0
      ? moveAlongHeading(motion.position, heading, distanceM)
      : { ...motion.position };

  return {
    ...motion,
    heading,
    speedKn,
    position: {
      lat: position.lat,
      lon: position.lon,
      depth: motion.position.depth,
    },
  };
}

/**
 * Deterministic end-of-turn tip for umpire GT prediction (no random wander).
 * Uses current heading/speed over `turnLengthSeconds`.
 */
export function predictNoisemakerDriftTip(
  track: NoisemakerTrack,
  turnLengthSeconds: number,
): { lat: number; lon: number } | null {
  if (track.status !== 'active') return null;
  const motion = ensureNoisemakerMotion(track, () => 0.5);
  const turnLen =
    typeof turnLengthSeconds === 'number' &&
    Number.isFinite(turnLengthSeconds) &&
    turnLengthSeconds > 0
      ? turnLengthSeconds
      : DEFAULT_TURN_LENGTH_SECONDS;
  const distanceM = motion.speedKn * KNOTS_TO_MPS * turnLen;
  if (distanceM <= 0) return null;
  const tip = moveAlongHeading(motion.position, motion.heading, distanceM);
  return { lat: tip.lat, lon: tip.lon };
}

/**
 * Drift active noisemakers, then expire those whose lifetime has elapsed
 * (`turnNumber` is the resolving turn).
 */
export function advanceNoisemakerTracks(
  tracks: readonly NoisemakerTrack[],
  turnNumber: number,
  turnLengthSeconds: number = DEFAULT_TURN_LENGTH_SECONDS,
  rng: () => number = Math.random,
): NoisemakerTrack[] {
  return tracks.map((t) => {
    if (t.status !== 'active') return t;
    // Newly ejected this resolve: assign motion and hold at deploy lat/lon
    // for this frame (heading/speed already set on create). Drift starts
    // on the next resolve so deploy-point GT / hydro range checks stay clean.
    const drifted =
      t.deployedTurn === turnNumber ? ensureNoisemakerMotion(t, rng) : driftNoisemakerTrack(t, turnLengthSeconds, rng);
    if (turnNumber >= drifted.expiresTurn) {
      return { ...drifted, status: 'spent' as const };
    }
    return drifted;
  });
}

/** Active tracks only (still emitting). */
export function activeNoisemakers(tracks: readonly NoisemakerTrack[] | undefined): NoisemakerTrack[] {
  return (tracks ?? []).filter((t) => t.status === 'active');
}

export function noisemakerSourceLevel(): number {
  return NOISEMAKER_SOURCE_LEVEL;
}
