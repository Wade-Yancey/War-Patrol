import type { EotSetting, VesselType } from './types.js';

/** Target speed (knots) for an EOT setting relative to vessel maxSpeed. */
export function eotTargetSpeed(eot: EotSetting, maxSpeed: number): number {
  const abs = Math.abs(maxSpeed);
  switch (eot) {
    case 'stop':
      return 0;
    case 'ahead_1':
      return abs * 0.15;
    case 'ahead_2':
      return abs * 0.3;
    case 'ahead_3':
      return abs * 0.45;
    case 'ahead_standard':
      return abs * 0.6;
    case 'ahead_full':
      return abs * 0.85;
    case 'ahead_flank':
      return abs;
    case 'back_1':
      return -abs * 0.15;
    case 'back_2':
      return -abs * 0.3;
    case 'back_full':
      return -abs * 0.5;
    default:
      return 0;
  }
}

/**
 * NPC aircraft speed bands (v1) — fixed small set + loiter.
 * Stored on the unit via the existing EOT field; see {@link eotToAircraftBand}.
 */
export type AircraftSpeedBand = 'loiter' | 'cruise' | 'full';

/** Fractions of aircraft maxSpeed for the three v1 bands. */
export const AIRCRAFT_SPEED_BAND_FRACTIONS: Record<AircraftSpeedBand, number> = {
  /** Station-keeping / orbit — not a hard stop (WWII props still make way). */
  loiter: 0.35,
  cruise: 0.65,
  full: 1.0,
};

export const AIRCRAFT_SPEED_BAND_LABELS: Record<AircraftSpeedBand, string> = {
  loiter: 'LOITER',
  cruise: 'CRUISE',
  full: 'FULL',
};

/** Preferred EOT values umpire/NPC should ring for aircraft bands. */
export const AIRCRAFT_BAND_EOT: Record<AircraftSpeedBand, EotSetting> = {
  loiter: 'stop',
  cruise: 'ahead_standard',
  full: 'ahead_flank',
};

/**
 * Map a stored EOT onto the aircraft band.
 * Reverse bells and slow-ahead collapse to loiter (aircraft have no astern).
 */
export function eotToAircraftBand(eot: EotSetting): AircraftSpeedBand {
  switch (eot) {
    case 'ahead_full':
    case 'ahead_flank':
      return 'full';
    case 'ahead_2':
    case 'ahead_3':
    case 'ahead_standard':
      return 'cruise';
    default:
      return 'loiter';
  }
}

/** Always-non-negative target knots for aircraft from EOT / band mapping. */
export function aircraftTargetSpeed(eot: EotSetting, maxSpeed: number): number {
  const abs = Math.abs(maxSpeed);
  if (!Number.isFinite(abs) || abs <= 0) return 0;
  const band = eotToAircraftBand(eot);
  return abs * AIRCRAFT_SPEED_BAND_FRACTIONS[band];
}

/**
 * Target speed for turn resolution: naval EOT for ships/subs;
 * three-band aircraft model (loiter / cruise / full) for Aircraft.
 */
export function targetSpeedForUnit(
  type: VesselType | string | undefined,
  eot: EotSetting,
  maxSpeed: number,
): number {
  if (type === 'Aircraft') return aircraftTargetSpeed(eot, maxSpeed);
  return eotTargetSpeed(eot, maxSpeed);
}

export const EOT_LABELS: Record<EotSetting, string> = {
  stop: 'STOP',
  ahead_1: 'AHEAD 1/3',
  ahead_2: 'AHEAD 2/3',
  ahead_3: 'AHEAD 3/3',
  ahead_standard: 'AHEAD STD',
  ahead_full: 'AHEAD FULL',
  ahead_flank: 'AHEAD FLANK',
  back_1: 'BACK 1/3',
  back_2: 'BACK 2/3',
  back_full: 'BACK FULL',
};

export const ALL_EOT_SETTINGS: EotSetting[] = [
  'back_full',
  'back_2',
  'back_1',
  'stop',
  'ahead_1',
  'ahead_2',
  'ahead_3',
  'ahead_standard',
  'ahead_full',
  'ahead_flank',
];
