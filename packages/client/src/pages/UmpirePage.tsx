import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DEFAULT_TURN_SECONDS,
  TIMER_EXTEND_SECONDS,
  TIMER_STEP_SECONDS,
  formatGameClock,
  formatWallDuration,
  parseWallDuration,
  snapWallDuration,
  type UmpireView,
} from '@war-patrol/shared';
import { api } from '../api/client';
import { useGameStream } from '../hooks/useGameStream';
import { GroundTruthMap } from '../components/GroundTruthMap';
import { TurnStatus } from '../components/TurnStatus';
import { CrtShell } from '../components/CrtShell';
import { TouchNumber } from '../components/TouchNumber';
import { ConfirmAction } from '../components/ConfirmAction';

function tokenKey(gameId: string) {
  return `wp-token:${gameId}:umpire`;
}

export function UmpirePage() {
  const { gameId = '' } = useParams();
  const [password, setPassword] = useState('umpire');
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey(gameId)));
  const [authError, setAuthError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(DEFAULT_TURN_SECONDS);
  const [editUnitId, setEditUnitId] = useState<string>('');
  const [editHealth, setEditHealth] = useState(100);
  const [editDepth, setEditDepth] = useState(0);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);

  const { view, stateVersion, connected, error, refresh } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
  });

  const umpire = view?.role === 'umpire' ? (view as UmpireView) : null;
  const phase = umpire?.turn.phase;
  const isOpen = phase === 'open';
  const isLocked = phase === 'locked' || phase === 'awaiting_resolution';

  const selectedUnit = useMemo(
    () => umpire?.units.find((u) => u.id === editUnitId) ?? umpire?.units[0],
    [umpire, editUnitId],
  );

  useEffect(() => {
    if (!umpire) return;
    setTimerSeconds(snapWallDuration(umpire.turn.timerSeconds, TIMER_STEP_SECONDS));
  }, [umpire]);

  useEffect(() => {
    if (!selectedUnit) return;
    setEditHealth(selectedUnit.health);
    setEditDepth(Math.round(selectedUnit.position.depth));
  }, [selectedUnit?.id, stateVersion]);

  const login = async (e?: FormEvent) => {
    e?.preventDefault();
    setAuthError(null);
    try {
      const auth = await api.authUmpire(gameId, password);
      sessionStorage.setItem(tokenKey(gameId), auth.token);
      setToken(auth.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Auth failed');
    }
  };

  /** Run umpire action; always refresh view so tablet UI stays in sync even if SSE hiccups. */
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed');
      try {
        await refresh();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <CrtShell>
        <div className="app-shell">
          <span className="brand-mark">Umpire console</span>
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
      </CrtShell>
    );
  }

  return (
    <CrtShell>
      <div className="app-shell">
        <header className="header-bar">
          <div>
            <span className="brand-mark">Umpire · ground truth</span>
            <p className="brand" style={{ fontSize: 'clamp(1.35rem, 3.5vw, 1.85rem)' }}>
              War Patrol
            </p>
            <p className="muted" style={{ margin: '0.25rem 0 0' }}>
              {umpire?.name ?? gameId}
            </p>
          </div>
          <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <span className={`live-dot ${connected ? '' : 'off'}`} />
              <span className="mono muted">{connected ? 'LIVE' : 'RECONNECTING'}</span>
              <span className="mono muted">v{stateVersion}</span>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              Refresh
            </button>
            <Link to="/">Home</Link>
          </div>
        </header>

        {(error || actionError) && <p className="error">{error || actionError}</p>}

        {umpire && (
          <>
            <section className="panel stack">
              <h2>Turn status</h2>
              <TurnStatus turn={umpire.turn} turnLengthSeconds={umpire.turnLengthSeconds} />
              <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                Open = crews enter orders · Lock = freeze orders · Resolve = apply movement and open the next
                turn.
              </p>
            </section>

            <div className="umpire-controls" style={{ marginTop: '1rem' }}>
              <section className="panel stack umpire-control-group">
                <h2>1 · Timer</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Counts down while the turn is open. Expiry auto-locks orders. Adjust in 30s or
                  1‑minute steps.
                </p>
                <TouchNumber
                  label="Order timer"
                  value={timerSeconds}
                  onChange={setTimerSeconds}
                  min={0}
                  max={3600}
                  step={TIMER_STEP_SECONDS}
                  showSlider
                  format={formatWallDuration}
                  parse={parseWallDuration}
                  hint="±30s · tap to type minutes (3 or 3:30) · 0–60m"
                />
                <div className="control-actions">
                  <button
                    type="button"
                    disabled={busy || timerSeconds < 60}
                    onClick={() =>
                      setTimerSeconds((s) =>
                        snapWallDuration(Math.max(0, s - 60), TIMER_STEP_SECONDS),
                      )
                    }
                  >
                    −1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || timerSeconds >= 3600}
                    onClick={() =>
                      setTimerSeconds((s) =>
                        snapWallDuration(Math.min(3600, s + 60), TIMER_STEP_SECONDS),
                      )
                    }
                  >
                    +1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnTimer(gameId, token, timerSeconds))}
                  >
                    Start / set timer
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() =>
                      void run(() => api.turnExtend(gameId, token, TIMER_STEP_SECONDS))
                    }
                  >
                    Extend +30s
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() =>
                      void run(() => api.turnExtend(gameId, token, TIMER_EXTEND_SECONDS))
                    }
                  >
                    Extend +1 min
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnResetTimer(gameId, token))}
                  >
                    Restart timer
                  </button>
                </div>
              </section>

              <section className="panel stack umpire-control-group">
                <h2>2 · Order lock</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Lock closes ordering. Reopen returns to open without moving ships.
                </p>
                <div className="control-actions">
                  <button
                    type="button"
                    disabled={busy || !isOpen}
                    onClick={() => void run(() => api.turnLock(gameId, token))}
                  >
                    Lock orders
                  </button>
                  <button
                    type="button"
                    disabled={busy || !isLocked}
                    onClick={() => void run(() => api.turnReopen(gameId, token))}
                  >
                    Reopen orders
                  </button>
                </div>
              </section>

              <section className="panel stack umpire-control-group">
                <h2>3 · Resolve turn</h2>
                <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                  Applies all vessel orders, advances the plot, then opens the next turn. Works from open or
                  locked.
                </p>
                <div className="control-actions">
                  <button
                    className="primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.turnResolve(gameId, token))}
                  >
                    Resolve &amp; advance
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.saveGame(gameId, token))}
                  >
                    Save to disk
                  </button>
                </div>
                {umpire.historyTurnNumbers.length > 0 && (
                  <div className="stack" style={{ gap: '0.4rem' }}>
                    <span className="muted" style={{ fontSize: '0.8rem' }}>
                      Rollback to end of turn (requires confirmation):
                    </span>
                    <div className="row">
                      {umpire.historyTurnNumbers.map((n) => (
                        <button
                          key={n}
                          type="button"
                          className="danger"
                          disabled={busy || rollbackTarget !== null}
                          onClick={() => setRollbackTarget(n)}
                        >
                          T{n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </div>

            {rollbackTarget !== null && token && (
              <div style={{ marginTop: '1rem' }}>
                <ConfirmAction
                  title={`Rollback to end of turn ${rollbackTarget}`}
                  warning={
                    <>
                      <p>
                        <strong>Destructive.</strong> Restores units to the snapshot after turn{' '}
                        {rollbackTarget} resolved, clears in-progress orders, and discards every later
                        turn.
                      </p>
                      <p>
                        Current turn {umpire.turn.number} and in-game clock{' '}
                        <span className="mono">{formatGameClock(umpire.turn.gameTimeSeconds)}</span>{' '}
                        will be replaced by the restored clock. Later movement and history are gone.
                      </p>
                    </>
                  }
                  confirmTokens={['ROLLBACK', String(rollbackTarget)]}
                  confirmHint={`Type ROLLBACK or ${rollbackTarget} to confirm`}
                  placeholder="ROLLBACK"
                  confirmLabel={`Execute rollback to T${rollbackTarget}`}
                  busy={busy}
                  onCancel={() => setRollbackTarget(null)}
                  onConfirm={(matched) =>
                    void run(async () => {
                      await api.rollback(gameId, token, rollbackTarget, matched);
                      setRollbackTarget(null);
                    })
                  }
                />
              </div>
            )}

            <div className="grid-2" style={{ marginTop: '1rem' }}>
              <section className="panel">
                <h2>Ground truth</h2>
                <GroundTruthMap
                  area={umpire.operatingArea}
                  units={umpire.units}
                  trails={umpire.trails}
                />
              </section>

              <div className="stack">
                <section className="panel">
                  <h2>Vessel links &amp; passwords</h2>
                  <p className="muted" style={{ marginTop: 0, fontSize: '0.8rem' }}>
                    Destroyers and submarines include a dedicated <strong>Radar</strong> station plus an
                    installed radar sensor. Sub radar (own PPI and as a contact) only when surfaced (depth ≤ 5
                    m).
                  </p>
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
                                <div key={s.stationId}>
                                  <Link to={s.path}>{s.name}</Link>
                                  <span className="mono muted" style={{ marginLeft: 8, fontSize: '0.7rem' }}>
                                    {s.path}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              disabled={busy}
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
                        if (u) {
                          setEditHealth(u.health);
                          setEditDepth(Math.round(u.position.depth));
                        }
                      }}
                    >
                      {umpire.units.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TouchNumber
                    label="Health (placeholder)"
                    value={editHealth}
                    onChange={setEditHealth}
                    min={0}
                    max={100}
                    step={5}
                    unit="%"
                  />
                  <TouchNumber
                    label="Depth (radar: surface ≤5 m)"
                    value={editDepth}
                    onChange={setEditDepth}
                    min={0}
                    max={300}
                    step={5}
                    unit="m"
                    showSlider
                  />
                  <div className="control-actions">
                    <button
                      type="button"
                      disabled={!selectedUnit || busy}
                      onClick={() =>
                        void run(() =>
                          api.updateUnit(gameId, token, selectedUnit!.id, { health: editHealth }),
                        )
                      }
                    >
                      Apply health
                    </button>
                    <button
                      type="button"
                      disabled={!selectedUnit || busy}
                      onClick={() =>
                        void run(() =>
                          api.updateUnit(gameId, token, selectedUnit!.id, {
                            position: { depth: editDepth },
                          }),
                        )
                      }
                    >
                      Apply depth
                    </button>
                  </div>
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
                          disabled={busy}
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
    </CrtShell>
  );
}
