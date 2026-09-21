import {
  FLEET_SUB_CRUSH_DEPTH_M,
  FLEET_SUB_PATROL_DEPTH_M,
  FLEET_SUB_TEST_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_DEPTH_RATE_M_PER_MIN,
  SUBMARINE_IMPLOSION_CHANCE_PER_TURN,
  SUBMARINE_MAX_DEPTH_M,
} from './constants.js';
import { disabledAllSubsystems } from './damage.js';
import type { CombatLogEntry, UnitState } from './types.js';

/**
 * Named dive / depth presets for fleet submarines (WWII / early Cold War inspired).
 * Depths are meters positive-down on the coarse order grid. Ships do not use these.
 */
export type DivePresetId =
  | 'surface'
  | 'periscope'
  | 'patrol'
  | 'test'
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
 * Values sit on {@link SUBMARINE_DEPTH_ORDER_STEP_M} so the Dive dial stays coarse.
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
    depthM: 20,
    rationale: '~60 ft periscope depth rounded to coarse 20 m dial',
  },
  {
    id: 'patrol',
    label: 'Patrol',
    depthM: FLEET_SUB_PATROL_DEPTH_M,
    rationale: 'Typical submerged patrol / cruise — safe operating band',
  },
  {
    id: 'test',
    label: 'Test',
    depthM: FLEET_SUB_TEST_DEPTH_M,
    rationale: 'Design test depth (~300 ft) — below this enters risk',
  },
  {
    id: 'emergency_blow',
    label: 'Emergency blow',
    depthM: 0,
    rationale: 'Blow ballast — order to surface (0 m)',
  },
] as const;

/** Read-only band marks for Dive / Controls UI (not all are one-click presets). */
export const DIVE_BAND_MARKS = [
  { id: 'patrol', label: 'Patrol', depthM: FLEET_SUB_PATROL_DEPTH_M },
  { id: 'test', label: 'Test', depthM: FLEET_SUB_TEST_DEPTH_M },
  { id: 'crush', label: 'Crush', depthM: FLEET_SUB_CRUSH_DEPTH_M },
] as const;

export type SubmarineDepthRisk = 'safe' | 'below_test' | 'at_crush' | 'past_crush';

export function divePresetById(id: DivePresetId): DivePreset | undefined {
  return DIVE_PRESETS.find((p) => p.id === id);
}

/**
 * Snap a depth to the coarse submarine order grid (10 m), then clamp to
 * [0, {@link SUBMARINE_MAX_DEPTH_M}]. Used for orders and operator display.
 */
export function quantizeSubmarineDepth(depthM: number): number {
  if (!Number.isFinite(depthM)) return 0;
  const step = Math.max(1, SUBMARINE_DEPTH_ORDER_STEP_M);
  const snapped = Math.round(depthM / step) * step;
  return Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, snapped));
}

/** Clamp + quantize a submarine ordered depth to the coarse dial. */
export function clampSubmarineDepth(depthM: number): number {
  return quantizeSubmarineDepth(depthM);
}

/**
 * Operator CRT depth string — always coarse-stepped so players do not see
 * 1 m GT precision on the Dive dial / status strip.
 */
export function formatCoarseDepthMeters(depthM: number): string {
  const q = quantizeSubmarineDepth(depthM);
  return `${String(q).padStart(3, '0')} m`;
}

/** True when keel is strictly deeper than crush (implosion band). */
export function isPastCrushDepth(
  depthM: number,
  crushM: number = FLEET_SUB_CRUSH_DEPTH_M,
): boolean {
  return Number.isFinite(depthM) && depthM > crushM;
}

/** Risk band for keel or ordered depth relative to test / crush marks. */
export function submarineDepthRisk(
  depthM: number,
  opts: { testM?: number; crushM?: number } = {},
): SubmarineDepthRisk {
  const testM = opts.testM ?? FLEET_SUB_TEST_DEPTH_M;
  const crushM = opts.crushM ?? FLEET_SUB_CRUSH_DEPTH_M;
  if (!Number.isFinite(depthM)) return 'safe';
  if (depthM > crushM) return 'past_crush';
  if (depthM >= crushM) return 'at_crush';
  if (depthM > testM) return 'below_test';
  return 'safe';
}

/**
 * Roll implosion for one turn past crush.
 * @param rng unit interval RNG (injectable for tests)
 */
export function rollSubmarineImplosion(
  rng: () => number = Math.random,
  chance: number = SUBMARINE_IMPLOSION_CHANCE_PER_TURN,
): boolean {
  const p = Math.max(0, Math.min(1, chance));
  if (!(p > 0)) return false;
  return rng() < p;
}

/**
 * Catastrophic hull loss — same end state as lethal combat damage.
 */
export function implodeSubmarine(unit: UnitState): UnitState {
  if (unit.condition === 'sunk') return unit;
  return {
    ...unit,
    health: 0,
    condition: 'sunk',
    speed: 0,
    eot: 'stop',
    activeSonarEnabled: false,
    periscopeRaised: false,
    periscopeExposure: 0,
    plotStampTurns: 0,
    subsystems: disabledAllSubsystems(),
  };
}

export type CrushImplosionResult = {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
};

/**
 * Each resolve: any submarine with keel **past** crush depth rolls implosion.
 * Survivors remain playable; imploded hulls are sunk and get an umpire log line.
 */
export function applyCrushDepthImplosions(
  units: UnitState[],
  opts: {
    turnNumber: number;
    gameTimeSeconds: number;
    rng?: () => number;
    chance?: number;
    crushM?: number;
    nowIso?: string;
  },
): CrushImplosionResult {
  const rng = opts.rng ?? Math.random;
  const chance = opts.chance ?? SUBMARINE_IMPLOSION_CHANCE_PER_TURN;
  const crushM = opts.crushM ?? FLEET_SUB_CRUSH_DEPTH_M;
  const at = opts.nowIso ?? new Date().toISOString();
  const combatLogEntries: CombatLogEntry[] = [];

  const next = units.map((unit) => {
    if (unit.type !== 'Submarine' || unit.condition === 'sunk') return unit;
    if (!isPastCrushDepth(unit.position.depth, crushM)) return unit;
    if (!rollSubmarineImplosion(rng, chance)) return unit;

    const sunk = implodeSubmarine(unit);
    combatLogEntries.push({
      id: `cl-implode-${unit.id}-t${opts.turnNumber}`,
      kind: 'hull_implosion',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      at,
      summary: `${unit.name} IMPLODED — hull crushed past crush depth (${crushM} m)`,
      targetUnitId: unit.id,
      targetName: unit.name,
    });
    return sunk;
  });

  return { units: next, combatLogEntries };
}

/**
 * Step keel depth toward ordered depth by at most `rateMPerMin × turnMinutes`.
 * Does not overshoot the ordered set-point. Ships never call this.
 * Keel may take intermediate values between coarse order steps during transit;
 * orders and Dive UI stay quantized.
 */
export function stepDepthTowardOrdered(
  currentDepthM: number,
  orderedDepthM: number,
  turnLengthSeconds: number,
  rateMPerMin: number = SUBMARINE_DEPTH_RATE_M_PER_MIN,
): number {
  const current = Number.isFinite(currentDepthM)
    ? Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, currentDepthM))
    : 0;
  const ordered = clampSubmarineDepth(orderedDepthM);
  if (Math.abs(current - ordered) < 1e-6) return ordered;

  const minutes = Math.max(0, turnLengthSeconds) / 60;
  const maxStep = Math.max(0, rateMPerMin) * minutes;
  if (!(maxStep > 0)) return current;

  if (current < ordered) {
    const next = Math.min(ordered, current + maxStep);
    return Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, next));
  }
  const next = Math.max(ordered, current - maxStep);
  return Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, next));
}
