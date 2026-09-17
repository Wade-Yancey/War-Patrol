import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ALL_EOT_SETTINGS, EOT_LABELS, type EotSetting, type VesselView } from '@war-patrol/shared';
import { api } from '../api/client';
import { useGameStream } from '../hooks/useGameStream';
import { TurnStatus } from '../components/TurnStatus';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

export function StationPage() {
  const { gameId = '', accessToken = '', stationId = '' } = useParams();
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(() =>
    sessionStorage.getItem(tokenKey(gameId, accessToken, stationId)),
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [course, setCourse] = useState(0);
  const [eot, setEot] = useState<EotSetting>('ahead_standard');
  const [seeded, setSeeded] = useState(false);

  const { view, stateVersion, connected, error } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
  });

  const vessel = view?.role === 'vessel' ? (view as VesselView) : null;

  useEffect(() => {
    if (!vessel || seeded) return;
    setSeeded(true);
    setCourse(Math.round(vessel.unit.orders.course ?? vessel.unit.heading));
    setEot(vessel.unit.orders.eot ?? vessel.unit.eot);
  }, [vessel, seeded]);

  const caps = useMemo(() => new Set(vessel?.station.capabilities ?? []), [vessel]);
  const canHelm = caps.has('helm');
  const canEot = caps.has('engineering') || caps.has('helm');
  const stubCaps = [...caps].filter((c) => c !== 'helm' && c !== 'engineering');

  const login = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    try {
      const auth = await api.authVessel(gameId, {
        accessToken,
        password: password || undefined,
        stationId,
      });
      sessionStorage.setItem(tokenKey(gameId, accessToken, stationId), auth.token);
      setToken(auth.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Auth failed');
    }
  };

  const submit = async (patch: { course?: number; eot?: EotSetting }) => {
    if (!token) return;
    setActionError(null);
    try {
      await api.orders(gameId, token, patch);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Order failed');
    }
  };

  if (!token) {
    return (
      <div className="app-shell fade-in">
        <p className="brand">War Patrol</p>
        <p className="subhead">
          Station join · vessel <span className="mono">{accessToken}</span> ·{' '}
          <span className="mono">{stationId}</span>
        </p>
        {authError && <p className="error">{authError}</p>}
        <form className="panel stack" onSubmit={login} style={{ maxWidth: 420, marginTop: '1.5rem' }}>
          <label>
            Vessel password (if required)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </label>
          <button className="primary" type="submit">
            Enter station
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
          <p className="brand" style={{ fontSize: '1.35rem' }}>
            War Patrol
          </p>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {vessel ? (
              <>
                {vessel.unit.name} · {vessel.station.name}
              </>
            ) : (
              'Connecting…'
            )}
          </p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className={`live-dot ${connected ? '' : 'off'}`} />
            <span className="mono muted">v{stateVersion}</span>
          </div>
        </div>
      </header>

      {(error || actionError) && <p className="error">{error || actionError}</p>}

      {vessel && (
        <>
          <section className="panel stack">
            <h2>Turn</h2>
            <TurnStatus turn={vessel.turn} />
            {!vessel.canSubmitOrders && (
              <p className="muted" style={{ margin: 0 }}>
                Ordering closed for this phase or this station cannot submit.
              </p>
            )}
            {vessel.stationConnections.some((c) => c.count > 1) && (
              <p className="mono" style={{ margin: 0, color: 'var(--accent-strong)' }}>
                Multi-connection: last write wins —{' '}
                {vessel.stationConnections
                  .filter((c) => c.count > 0)
                  .map((c) => `${c.stationId}×${c.count}`)
                  .join(', ')}
              </p>
            )}
          </section>

          <div className="grid-2" style={{ marginTop: '1rem' }}>
            <section className="panel">
              <h2>Own ship readouts</h2>
              <table className="table mono">
                <tbody>
                  <tr>
                    <th>Lat</th>
                    <td>{vessel.unit.position.lat.toFixed(4)}</td>
                  </tr>
                  <tr>
                    <th>Lon</th>
                    <td>{vessel.unit.position.lon.toFixed(4)}</td>
                  </tr>
                  <tr>
                    <th>Depth</th>
                    <td>{vessel.unit.position.depth.toFixed(0)} m</td>
                  </tr>
                  <tr>
                    <th>Heading</th>
                    <td>{vessel.unit.heading.toFixed(0)}°</td>
                  </tr>
                  <tr>
                    <th>Speed</th>
                    <td>{vessel.unit.speed.toFixed(1)} kn</td>
                  </tr>
                  <tr>
                    <th>EOT</th>
                    <td>{EOT_LABELS[vessel.unit.eot]}</td>
                  </tr>
                  <tr>
                    <th>Orders</th>
                    <td>
                      {vessel.unit.orders.course !== undefined
                        ? `CRS ${vessel.unit.orders.course.toFixed(0)}°`
                        : '—'}
                      {' / '}
                      {vessel.unit.orders.eot ? EOT_LABELS[vessel.unit.orders.eot] : '—'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>

            <div className="stack">
              {canHelm && (
                <section className="panel stack">
                  <h2>Helm</h2>
                  <label>
                    Desired course (°)
                    <input
                      type="number"
                      min={0}
                      max={359}
                      value={course}
                      onChange={(e) => setCourse(Number(e.target.value))}
                      disabled={!vessel.canSubmitOrders}
                    />
                  </label>
                  <button
                    className="primary"
                    type="button"
                    disabled={!vessel.canSubmitOrders}
                    onClick={() => void submit({ course })}
                  >
                    Submit course
                  </button>
                </section>
              )}

              {canEot && (
                <section className="panel stack">
                  <h2>Engine order telegraph</h2>
                  <label>
                    Desired EOT
                    <select
                      value={eot}
                      onChange={(e) => setEot(e.target.value as EotSetting)}
                      disabled={!vessel.canSubmitOrders}
                    >
                      {ALL_EOT_SETTINGS.map((s) => (
                        <option key={s} value={s}>
                          {EOT_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="primary"
                    type="button"
                    disabled={!vessel.canSubmitOrders}
                    onClick={() => void submit({ eot })}
                  >
                    Ring up EOT
                  </button>
                </section>
              )}

              {stubCaps.length > 0 && (
                <section className="panel">
                  <h2>Other stations (stub)</h2>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Capability panels deferred past Phase 1:
                  </p>
                  <div className="row">
                    {stubCaps.map((c) => (
                      <span key={c} className="status-pill">
                        {c}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
