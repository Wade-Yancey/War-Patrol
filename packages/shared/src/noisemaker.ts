import {
  NOISEMAKER_COOLDOWN_TURNS,
  NOISEMAKER_LIFETIME_TURNS,
  NOISEMAKER_SOURCE_LEVEL,
} from './constants.js';
import { clampSubmarineDepth } from './dive.js';
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

/** Create a stationary noisemaker track at the sub's lat/lon and chosen depth. */
export function createNoisemakerTrack(opts: {
  id: string;
  deployerUnitId: string;
  position: LatLonDepth;
  deployedTurn: number;
}): NoisemakerTrack {
  const depth = clampNoisemakerDepthM(opts.position.depth);
  return {
    id: opts.id,
    deployerUnitId: opts.deployerUnitId,
    position: {
      lat: opts.position.lat,
      lon: opts.position.lon,
      depth,
    },
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

/** Expire noisemakers whose lifetime has elapsed (turnNumber is the resolving turn). */
export function advanceNoisemakerTracks(
  tracks: readonly NoisemakerTrack[],
  turnNumber: number,
): NoisemakerTrack[] {
  return tracks.map((t) => {
    if (t.status !== 'active') return t;
    if (turnNumber >= t.expiresTurn) {
      return { ...t, status: 'spent' as const };
    }
    return t;
  });
}

/** Active tracks only (still emitting). */
export function activeNoisemakers(tracks: readonly NoisemakerTrack[] | undefined): NoisemakerTrack[] {
  return (tracks ?? []).filter((t) => t.status === 'active');
}

export function noisemakerSourceLevel(): number {
  return NOISEMAKER_SOURCE_LEVEL;
}
