import { SUBMARINE_MAX_DEPTH_M } from './constants.js';

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
