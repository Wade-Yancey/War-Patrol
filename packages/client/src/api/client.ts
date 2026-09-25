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
  scenarios: (adminToken?: string) =>
    request<Array<{ id: string; name: string; description?: string; mode: string; unitCount: number }>>(
      '/api/scenarios',
      { token: adminToken },
    ),
  saves: (adminToken?: string) =>
    request<Array<{ id: string; name: string; updatedAt: string }>>('/api/saves', {
      token: adminToken,
    }),
  createGame: (scenarioId: string, name?: string, adminToken?: string) =>
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
    }>('/api/games', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ scenarioId, name }),
    }),
  loadSave: (saveId: string, adminToken?: string) =>
    request<{ gameId: string; name: string }>(`/api/saves/${saveId}/load`, {
      method: 'POST',
      token: adminToken,
    }),
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
  deleteSave: (saveId: string, adminToken?: string) =>
    request<{ ok: boolean; deletedFile: boolean; unloaded: boolean }>(`/api/saves/${saveId}`, {
      method: 'DELETE',
      token: adminToken,
    }),
  deleteAllSaves: (adminToken?: string) =>
    request<{ ok: boolean; deleted: number; unloaded: number }>('/api/saves', {
      method: 'DELETE',
      token: adminToken,
    }),
  deleteScenario: (scenarioId: string, adminToken?: string) =>
    request<{ ok: boolean }>(`/api/scenarios/${scenarioId}`, {
      method: 'DELETE',
      token: adminToken,
    }),
  orders: (
    gameId: string,
    token: string,
    body: {
      course?: number;
      eot?: EotSetting;
      depth?: number;
      fireTorpedo?: {
        room?: 'forward' | 'aft';
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
  /** Umpire: apply course/EOT to all non-detached convoy members. */
  formationOrders: (
    gameId: string,
    token: string,
    formationId: string,
    body: { course?: number; eot?: EotSetting },
  ) =>
    request<{ ok: boolean; stateVersion: number }>(
      `/api/games/${gameId}/formations/${encodeURIComponent(formationId)}/orders`,
      {
        method: 'POST',
        token,
        body: JSON.stringify(body),
      },
    ),
  /**
   * Umpire: individual helm/EOT (any hull). Optional breakFormation / rejoinFormation
   * for convoy members — does not use the Navigation heading fiat path.
   */
  umpireUnitOrders: (
    gameId: string,
    token: string,
    unitId: string,
    body: {
      course?: number;
      eot?: EotSetting;
      breakFormation?: boolean;
      rejoinFormation?: boolean;
    },
  ) =>
    request<{
      ok: boolean;
      stateVersion: number;
      orders?: unknown;
      orderedCourse?: number;
      formationId?: string;
      formationDetached?: boolean;
    }>(`/api/games/${gameId}/units/${encodeURIComponent(unitId)}/orders`, {
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
  setPeriscope: (gameId: string, token: string, raised: boolean) =>
    request<{
      ok: boolean;
      stateVersion: number;
      periscopeRaised: boolean;
      periscopeExposure: number;
      plotStampTurns: number;
    }>(`/api/games/${gameId}/periscope`, {
      method: 'POST',
      token,
      body: JSON.stringify({ raised }),
    }),
  startTorpedoReload: (gameId: string, token: string, room: 'forward' | 'aft') =>
    request<{ ok: boolean; stateVersion: number }>(`/api/games/${gameId}/torpedo-reload`, {
      method: 'POST',
      token,
      body: JSON.stringify({ room }),
    }),
  startDepthChargeReload: (gameId: string, token: string) =>
    request<{ ok: boolean; stateVersion: number }>(
      `/api/games/${gameId}/depth-charge-reload`,
      {
        method: 'POST',
        token,
        body: '{}',
      },
    ),
  rearmUnit: (gameId: string, token: string, unitId: string) =>
    request<{
      ok: boolean;
      stateVersion: number;
      torpedoLoad: number;
      torpedoForward: number;
      torpedoAft: number;
      depthChargeLoad: number;
    }>(`/api/games/${gameId}/units/${unitId}/rearm`, {
      method: 'POST',
      token,
      body: '{}',
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
  setTurnNote: (gameId: string, token: string, turnNumber: number, note: string) =>
    request<{ ok: boolean; stateVersion: number; umpireNote: string }>(
      `/api/games/${gameId}/turn-notes`,
      {
        method: 'POST',
        token,
        body: JSON.stringify({ turnNumber, note }),
      },
    ),
  pushGopherTask: (
    gameId: string,
    token: string,
    body: { unitIds?: string[]; allVessels?: boolean; text: string; label?: string },
  ) =>
    request<{ ok: boolean; stateVersion: number }>(`/api/games/${gameId}/gopher-task`, {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    }),
  resolveGopherTask: (
    gameId: string,
    token: string,
    unitId: string,
    outcome: 'completed' | 'cleared' | 'failed',
  ) =>
    request<{ ok: boolean; stateVersion: number }>(
      `/api/games/${gameId}/units/${unitId}/gopher-task/resolve`,
      {
        method: 'POST',
        token,
        body: JSON.stringify({ outcome }),
      },
    ),
  rotateToken: (gameId: string, token: string, unitId: string) =>
    request<{ accessToken: string }>(`/api/games/${gameId}/units/${unitId}/rotate-token`, {
      method: 'POST',
      token,
      body: '{}',
    }),
};
