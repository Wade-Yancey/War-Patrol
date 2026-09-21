import type { ClientView, EotSetting } from '@war-patrol/shared';

async function request<T>(
  path: string,
  options: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...rest } = options;
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || res.statusText || 'Request failed');
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),
  scenarios: () =>
    request<Array<{ id: string; name: string; description?: string; mode: string; unitCount: number }>>(
      '/api/scenarios',
    ),
  saves: () => request<Array<{ id: string; name: string; updatedAt: string }>>('/api/saves'),
  createGame: (scenarioId: string, name?: string) =>
    request<{
      gameId: string;
      name: string;
      vesselLinks: Array<{
        unitId: string;
        name: string;
        accessToken: string;
        passwordProtected: boolean;
        stations: Array<{ stationId: string; name: string; path: string }>;
      }>;
    }>('/api/games', { method: 'POST', body: JSON.stringify({ scenarioId, name }) }),
  loadSave: (saveId: string) =>
    request<{ gameId: string; name: string }>(`/api/saves/${saveId}/load`, { method: 'POST' }),
  authUmpire: (gameId: string, password: string) =>
    request<{ token: string; role: string }>(`/api/games/${gameId}/auth/umpire`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  authVessel: (
    gameId: string,
    body: { accessToken: string; password?: string; stationId: string },
  ) =>
    request<{ token: string; role: string; unitId: string; stationId: string }>(
      `/api/games/${gameId}/auth/vessel`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  view: (gameId: string, token: string, init?: { signal?: AbortSignal }) =>
    request<{ stateVersion: number; view: ClientView }>(`/api/games/${gameId}/view`, {
      token,
      signal: init?.signal,
    }),
  saveGame: (gameId: string, token: string) =>
    request<{ ok: boolean }>(`/api/games/${gameId}/save`, { method: 'POST', token }),
  deleteSave: (saveId: string) =>
    request<{ ok: boolean; deletedFile: boolean; unloaded: boolean }>(`/api/saves/${saveId}`, {
      method: 'DELETE',
    }),
  deleteAllSaves: () =>
    request<{ ok: boolean; deleted: number; unloaded: number }>('/api/saves', {
      method: 'DELETE',
    }),
  deleteScenario: (scenarioId: string) =>
    request<{ ok: boolean }>(`/api/scenarios/${scenarioId}`, { method: 'DELETE' }),
  orders: (
    gameId: string,
    token: string,
    body: {
      course?: number;
      eot?: EotSetting;
      depth?: number;
      fireTorpedo?: {
        aimHeading: number;
        estimatedCourse: number;
        estimatedSpeedKn: number;
        estimatedRangeNm: number;
        estimatedLengthM: number;
        spreadCount?: number;
        spreadDeg?: number;
      } | null;
      dropDepthCharges?: {
        pattern: 'single' | 'pair' | 'pattern_3' | 'pattern_5';
        depthSettingM: number;
      } | null;
    },
  ) =>
    request<{ ok: boolean; stateVersion: number }>(`/api/games/${gameId}/orders`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    }),
  setActiveSonar: (gameId: string, token: string, enabled: boolean) =>
    request<{ ok: boolean; stateVersion: number; activeSonarEnabled: boolean }>(
      `/api/games/${gameId}/active-sonar`,
      {
        method: 'POST',
        token,
        body: JSON.stringify({ enabled }),
      },
    ),
  setPeriscope: (
    gameId: string,
    token: string,
    raised: boolean,
    exposure?: number,
  ) =>
    request<{
      ok: boolean;
      stateVersion: number;
      periscopeRaised: boolean;
      periscopeExposure: number;
      plotStampTurns: number;
    }>(`/api/games/${gameId}/periscope`, {
      method: 'POST',
      token,
      body: JSON.stringify(
        exposure === undefined ? { raised } : { raised, exposure },
      ),
    }),
  turnTimer: (gameId: string, token: string, seconds: number) =>
    request(`/api/games/${gameId}/turn/timer`, {
      method: 'POST',
      token,
      body: JSON.stringify({ seconds }),
    }),
  turnExtend: (gameId: string, token: string, seconds: number) =>
    request(`/api/games/${gameId}/turn/extend`, {
      method: 'POST',
      token,
      body: JSON.stringify({ seconds }),
    }),
  turnResetTimer: (gameId: string, token: string) =>
    request(`/api/games/${gameId}/turn/reset-timer`, { method: 'POST', token, body: '{}' }),
  turnLock: (gameId: string, token: string) =>
    request(`/api/games/${gameId}/turn/lock`, { method: 'POST', token, body: '{}' }),
  turnReopen: (gameId: string, token: string) =>
    request(`/api/games/${gameId}/turn/reopen`, { method: 'POST', token, body: '{}' }),
  turnResolve: (gameId: string, token: string) =>
    request(`/api/games/${gameId}/turn/resolve`, { method: 'POST', token, body: '{}' }),
  rollback: (gameId: string, token: string, turnNumber: number, confirm: string) =>
    request(`/api/games/${gameId}/rollback`, {
      method: 'POST',
      token,
      body: JSON.stringify({ turnNumber, confirm }),
    }),
  updateUnit: (
    gameId: string,
    token: string,
    unitId: string,
    body: Record<string, unknown>,
  ) =>
    request(`/api/games/${gameId}/units/${unitId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    }),
  rotateToken: (gameId: string, token: string, unitId: string) =>
    request<{ accessToken: string }>(`/api/games/${gameId}/units/${unitId}/rotate-token`, {
      method: 'POST',
      token,
      body: '{}',
    }),
};
