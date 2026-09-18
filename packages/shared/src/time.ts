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

/**
 * Wall-clock order/turn timer display (minutes first).
 * Examples: `0s`, `30s`, `3m`, `3m 30s`.
 */
export function formatWallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  if (rem === 0) return `${m}m`;
  return `${m}m ${rem}s`;
}

/**
 * Parse umpire-friendly duration input into seconds.
 * Accepts `3`, `3m`, `3:30`, `3m 30s`, `90s`. Bare numbers are minutes.
 */
export function parseWallDuration(raw: string): number | null {
  const t = raw.trim().toLowerCase().replace(/,/g, '');
  if (!t) return null;

  const withUnits = t.match(
    /^(\d+)\s*m(?:in(?:ute)?s?)?(?:\s*(\d+)\s*s(?:ec(?:ond)?s?)?)?$/,
  );
  if (withUnits) {
    return Number(withUnits[1]) * 60 + Number(withUnits[2] ?? 0);
  }

  const onlySeconds = t.match(/^(\d+)\s*s(?:ec(?:ond)?s?)?$/);
  if (onlySeconds) return Number(onlySeconds[1]);

  const colon = t.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (colon) {
    const sec = Number(colon[2]);
    if (sec >= 60) return null;
    return Number(colon[1]) * 60 + sec;
  }

  if (/^\d+$/.test(t)) {
    return Number(t) * 60;
  }

  return null;
}

/** Snap wall-clock timer seconds to a step (default 30s). */
export function snapWallDuration(seconds: number, step = 30): number {
  if (!Number.isFinite(seconds) || step <= 0) return 0;
  return Math.max(0, Math.round(seconds / step) * step);
}

export function resolveTurnLengthSeconds(value: number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_TURN_LENGTH_SECONDS;
}

export function resolveStartGameTimeSeconds(value: number | undefined | null): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_START_GAME_TIME_SECONDS;
}
