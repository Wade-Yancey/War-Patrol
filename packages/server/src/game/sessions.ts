import { nanoid } from 'nanoid';
import type { AuthSession } from '@war-patrol/shared';

export class SessionStore {
  private sessions = new Map<string, AuthSession>();

  create(input: Omit<AuthSession, 'token' | 'createdAt'>): AuthSession {
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
