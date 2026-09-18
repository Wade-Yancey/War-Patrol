import { nanoid } from 'nanoid';
import type { AuthSession } from '@war-patrol/shared';

export class SessionStore {
  private sessions = new Map<string, AuthSession>();

  create(input: Omit<AuthSession, 'token' | 'createdAt'>): AuthSession {
    // Always mint a new session — never revoke sibling tabs on the same station (ARCH-AC-09).
    const session: AuthSession = {
      ...input,
      token: nanoid(32),
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get(token: string | undefined | null): AuthSession | undefined {
    if (!token) return undefined;
    return this.sessions.get(token);
  }

  delete(token: string): void {
    this.sessions.delete(token);
  }

  /** Drop sessions for a game (e.g. after load overwrite). */
  clearGame(gameId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.gameId === gameId) this.sessions.delete(token);
    }
  }
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

/**
 * SSE auth token: Bearer header first, then `?token=` (EventSource cannot set headers).
 * Cookie session tokens are not used yet; query covers the browser EventSource case.
 */
export function parseSseToken(
  authorization: string | undefined,
  queryToken: string | string[] | undefined,
): string | undefined {
  const bearer = parseBearer(authorization);
  if (bearer) return bearer;
  if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken;
  if (Array.isArray(queryToken) && typeof queryToken[0] === 'string' && queryToken[0].length > 0) {
    return queryToken[0];
  }
  return undefined;
}

/** Redact `token` query values from URLs before logging. */
export function redactTokenQuery(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1[REDACTED]');
}
