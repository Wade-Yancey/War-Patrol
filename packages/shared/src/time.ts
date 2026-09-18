import { DEFAULT_START_GAME_TIME_SECONDS, DEFAULT_TURN_LENGTH_SECONDS } from './constants.js';

/** Format in-game clock seconds as HH:MM (24h, wraps daily). */
export function formatGameClock(gameTimeSeconds: number): string {
  const day = ((Math.floor(gameTimeSeconds) % 86400) + 86400) % 86400;
  const hh = String(Math.floor(day / 3600)).padStart(2, '0');
  const mm = String(Math.floor((day % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Format with seconds when useful (HH:MM:SS). */
export function formatGameClockHms(gameTimeSeconds: number): string {
  const day = ((Math.floor(gameTimeSeconds) % 86400) + 86400) % 86400;
  const hh = String(Math.floor(day / 3600)).padStart(2, '0');
  const mm = String(Math.floor((day % 3600) / 60)).padStart(2, '0');
  const ss = String(day % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function resolveTurnLengthSeconds(value: number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_TURN_LENGTH_SECONDS;
}

export function resolveStartGameTimeSeconds(value: number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_START_GAME_TIME_SECONDS;
}
