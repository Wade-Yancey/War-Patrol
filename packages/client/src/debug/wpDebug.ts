/**
 * Opt-in client diagnostics for tunnel SSE / peri FoW investigations.
 *
 * Enable with either:
 *   - URL query: `?wpDebug=1`
 *   - `localStorage.setItem('wpDebug', '1')` then reload
 *
 * Off by default so venue play stays quiet.
 */

let cachedEnabled: boolean | null = null;

export function isWpDebugEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    if (typeof window === 'undefined') {
      cachedEnabled = false;
      return false;
    }
    if (window.localStorage?.getItem('wpDebug') === '1') {
      cachedEnabled = true;
      return true;
    }
    const q = new URLSearchParams(window.location.search).get('wpDebug');
    cachedEnabled = q === '1';
    return cachedEnabled;
  } catch {
    cachedEnabled = false;
    return false;
  }
}

/** Reset cached flag (tests / toggling localStorage without reload). */
export function resetWpDebugCache(): void {
  cachedEnabled = null;
}

/** Redact `token` query values from URLs before logging. */
export function redactTokenQuery(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]');
}

export function wpDebug(tag: string, data?: Record<string, unknown>): void {
  if (!isWpDebugEnabled()) return;
  const payload = data ? { t: Date.now(), ...data } : { t: Date.now() };
  console.info(`[wpDebug:${tag}]`, payload);
}
