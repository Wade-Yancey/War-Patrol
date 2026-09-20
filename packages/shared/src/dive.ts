import {
  SUBMARINE_DEPTH_RATE_M_PER_MIN,
  SUBMARINE_MAX_DEPTH_M,
} from './constants.js';

/**
 * Named dive / depth presets for fleet submarines (WWII / early Cold War inspired).
 * Depths are meters positive-down. Ships do not use these.
 */
export type DivePresetId =
  | 'surface'
  | 'periscope'
  | 'patrol'
  | 'deep'
  | 'emergency_blow';

export interface DivePreset {
  id: DivePresetId;
  /** Operator-facing CRT label. */
  label: string;
  /** Ordered depth in meters (positive down). */
  depthM: number;
  /** Short rationale for docs / tooltips. */
  rationale: string;
}

/**
 * Sensible preset depths for Gato-class / fleet-boat play.
 * Surface band for radar remains ≤ {@link RADAR_SURFACE_DEPTH_M} (5 m).
 */
export const DIVE_PRESETS: readonly DivePreset[] = [
  {
    id: 'surface',
    label: 'Surface',
    depthM: 0,
    rationale: 'Fully surfaced / awash — radar usable (≤5 m band)',
  },
  {
    id: 'periscope',
    label: 'Periscope',
    depthM: 18,
    rationale: '~60 ft periscope depth (WWII fleet boat)',
  },
  {
    id: 'patrol',
    label: 'Patrol',
    depthM: 50,
    rationale: 'Typical submerged patrol / cruise depth',
  },
  {
    id: 'deep',
    label: 'Deep',
    depthM: 90,
    rationale: 'Near Gato test depth (~300 ft / 91 m)',
  },
  {
    id: 'emergency_blow',
    label: 'Emergency blow',
    depthM: 0,
    rationale: 'Blow ballast — order to surface (0 m)',
  },
] as const;

export function divePresetById(id: DivePresetId): DivePreset | undefined {
  return DIVE_PRESETS.find((p) => p.id === id);
}

/** Clamp a submarine ordered depth to [0, SUBMARINE_MAX_DEPTH_M]. */
export function clampSubmarineDepth(depthM: number): number {
  if (!Number.isFinite(depthM)) return 0;
  return Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, Math.round(depthM)));
}

/**
 * Step keel depth toward ordered depth by at most `rateMPerMin × turnMinutes`.
 * Does not overshoot the ordered set-point. Ships never call this.
 */
export function stepDepthTowardOrdered(
  currentDepthM: number,
  orderedDepthM: number,
  turnLengthSeconds: number,
  rateMPerMin: number = SUBMARINE_DEPTH_RATE_M_PER_MIN,
): number {
  const current = clampSubmarineDepth(currentDepthM);
  const ordered = clampSubmarineDepth(orderedDepthM);
  if (current === ordered) return current;

  const minutes = Math.max(0, turnLengthSeconds) / 60;
  const maxStep = Math.max(0, rateMPerMin) * minutes;
  if (!(maxStep > 0)) return current;

  if (current < ordered) {
    return clampSubmarineDepth(Math.min(ordered, current + maxStep));
  }
  return clampSubmarineDepth(Math.max(ordered, current - maxStep));
}
