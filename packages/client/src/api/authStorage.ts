/** Cross-tab session tokens (ARCH-AC-09: many station tabs at once). */

export function getAuthToken(key: string): string | null {
  try {
    const fromLocal = localStorage.getItem(key);
    if (fromLocal) return fromLocal;
  } catch {
    /* private mode / blocked storage */
  }
  try {
    const fromSession = sessionStorage.getItem(key);
    if (fromSession) {
      try {
        localStorage.setItem(key, fromSession);
      } catch {
        /* ignore migrate failure */
      }
      return fromSession;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function setAuthToken(key: string, token: string): void {
  try {
    localStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
}

/** Drop a stale session so the join form returns (e.g. after server restart). */
export function clearAuthToken(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
