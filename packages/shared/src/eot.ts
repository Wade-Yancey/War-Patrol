import type { EotSetting } from './types.js';

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
