/**
 * Opt-in server SSE / mast fan-out diagnostics.
 * Enable with `WAR_PATROL_DEBUG_SSE=1` (or `WAR_PATROL_DEBUG=1`).
 * Off by default — no log spam during venue play.
 */

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export function isSseDebugEnabled(): boolean {
  return envTruthy('WAR_PATROL_DEBUG_SSE') || envTruthy('WAR_PATROL_DEBUG');
}

export function sseDebug(tag: string, data?: Record<string, unknown>): void {
  if (!isSseDebugEnabled()) return;
  const payload = data ? { t: Date.now(), ...data } : { t: Date.now() };
  console.info(`[wpDebug:sse:${tag}]`, payload);
}
