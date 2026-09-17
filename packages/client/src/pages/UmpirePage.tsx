import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { UmpireView } from '@war-patrol/shared';
import { api } from '../api/client';
import { useGameStream } from '../hooks/useGameStream';
import { GroundTruthMap } from '../components/GroundTruthMap';
import { TurnStatus } from '../components/TurnStatus';

function tokenKey(gameId: string) {
  return `wp-token:${gameId}:umpire`;
}

export function UmpirePage() {
  const { gameId = '' } = useParams();
  const [password, setPassword] = useState('umpire');
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey(gameId)));
  const [authError, setAuthError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(180);
  const [editUnitId, setEditUnitId] = useState<string>('');
  const [editHealth, setEditHealth] = useState(100);

  const { view, stateVersion, connected, error } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
  });

  const umpire = view?.role === 'umpire' ? (view as UmpireView) : null;

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const auth = await api.authUmpire(gameId, password);
      sessionStorage.setItem(tokenKey(gameId), auth.token);
      setToken(auth.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Auth failed');
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const selectedUnit = useMemo(
    () => umpire?.units.find((u) => u.id === editUnitId) ?? umpire?.units[0],
    [umpire, editUnitId],
  );

  if (!token) {
    return (
      <div className="app-shell fade-in">
        <p className="brand">War Patrol</p>
        <p className="subhead">Umpire login for game {gameId}</p>
        {authError && <p className="error">{authError}</p>}
        <form className="panel stack" onSubmit={login} style={{ maxWidth: 420, marginTop: '1.5rem' }}>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          <button className="primary" type="submit">
            Enter umpire view
          </button>
          <Link to="/">← Home</Link>
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell fade-in">
      <header
        className="row"
        style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}
      >
        <div>
          <p className="brand" style={{ fontSize: '1.5rem' }}>
            War Patrol
          </p>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Umpire · {umpire?.name ?? gameId}
          </p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={`live-dot ${connected ? '' : 'off'}`} />
            <span className="mono muted">v{stateVersion}</span>
          </div>
          <Link to="/">Home</Link>
        </div>
      </header>

      {(error || actionError) && <p className="error">{error || actionError}</p>}

      {umpire && (
        <>
          <section className="panel stack">
            <h2>Turn controls</h2>
            <TurnStatus turn={umpire.turn} />
            <div className="row">
              <label>
                Timer (sec)
                <input
                  type="number"
                  min={0}
                  value={timerSeconds}
                  onChange={(e) => setTimerSeconds(Number(e.target.value))}
                  style={{ width: 100 }}
                />
              </label>
              <button type="button" onClick={() => void run(() => api.turnTimer(gameId, token, timerSeconds))}>
                Set timer
              </button>
              <button type="button" onClick={() => void run(() => api.turnExtend(gameId, token, 60))}>
                +60s
              </button>
              <button type="button" onClick={() => void run(() => api.turnResetTimer(gameId, token))}>
                Reset timer
              </button>
              <button type="button" onClick={() => void run(() => api.turnLock(gameId, token))}>
                Lock
              </button>
              <button type="button" onClick={() => void run(() => api.turnReopen(gameId, token))}>
                Reopen
              </button>
              <button
                className="primary"
                type="button"
                onClick={() => void run(() => api.turnResolve(gameId, token))}
              >
                Resolve
              </button>
              <button type="button" onClick={() => void run(() => api.saveGame(gameId, token))}>
                Save to disk
              </button>
            </div>
            {umpire.historyTurnNumbers.length > 0 && (
              <div className="row" style={{ alignItems: 'center' }}>
                <span className="muted">Rollback to end of turn:</span>
                {umpire.historyTurnNumbers.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="danger"
                    onClick={() => void run(() => api.rollback(gameId, token, n))}
                  >
                    T{n}
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="grid-2" style={{ marginTop: '1rem' }}>
            <section className="panel">
              <h2>Ground truth</h2>
              <GroundTruthMap area={umpire.operatingArea} units={umpire.units} />
            </section>

            <div className="stack">
              <section className="panel">
                <h2>Vessel links & passwords</h2>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Vessel</th>
                      <th>Stations</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {umpire.vesselLinks.map((v) => (
                      <tr key={v.unitId}>
                        <td>
                          <div>{v.name}</div>
                          <div className="mono muted" style={{ fontSize: '0.75rem' }}>
                            token {v.accessToken}
                            {v.passwordProtected ? ' · password set' : ' · open'}
                          </div>
                        </td>
                        <td>
                          <div className="stack" style={{ gap: '0.25rem' }}>
                            {v.stations.map((s) => (
                              <a key={s.stationId} href={`${origin}${s.path}`} target="_blank" rel="noreferrer">
                                {s.name}
                              </a>
                            ))}
                          </div>
                        </td>
                        <td>
                          <button
                            type="button"
                            onClick={() =>
                              void run(async () => {
                                await api.rotateToken(gameId, token, v.unitId);
                              })
                            }
                          >
                            Rotate token
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="panel stack">
                <h2>Unit edit</h2>
                <label>
                  Unit
                  <select
                    value={selectedUnit?.id ?? ''}
                    onChange={(e) => {
                      setEditUnitId(e.target.value);
                      const u = umpire.units.find((x) => x.id === e.target.value);
                      if (u) setEditHealth(u.health);
                    }}
                  >
                    {umpire.units.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Health (placeholder)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={editHealth}
                    onChange={(e) => setEditHealth(Number(e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  disabled={!selectedUnit}
                  onClick={() =>
                    void run(() =>
                      api.updateUnit(gameId, token, selectedUnit!.id, { health: editHealth }),
                    )
                  }
                >
                  Apply health
                </button>
                {selectedUnit && (
                  <label>
                    Vessel password
                    <div className="row">
                      <input
                        id="vessel-pw"
                        defaultValue={selectedUnit.password ?? ''}
                        key={selectedUnit.id + String(stateVersion)}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const el = document.getElementById('vessel-pw') as HTMLInputElement;
                          void run(() =>
                            api.updateUnit(gameId, token, selectedUnit.id, {
                              password: el.value,
                            }),
                          );
                        }}
                      >
                        Set password
                      </button>
                    </div>
                  </label>
                )}
              </section>

              <section className="panel">
                <h2>Connections</h2>
                {umpire.connections.length === 0 ? (
                  <p className="muted">No live SSE clients.</p>
                ) : (
                  <ul className="mono" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                    {umpire.connections.map((c, i) => (
                      <li key={i}>
                        {c.role}
                        {c.unitId ? ` · ${c.unitId}` : ''}
                        {c.stationId ? ` / ${c.stationId}` : ''} ×{c.count}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
