import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EOT_LABELS, conditionLabel, type EotSetting, type VesselView } from '@war-patrol/shared';
import { api } from '../api/client';
import { getAuthToken, setAuthToken } from '../api/authStorage';
import { useGameStream } from '../hooks/useGameStream';
import { TurnStatus } from '../components/TurnStatus';
import { CrtShell } from '../components/CrtShell';
import { TouchNumber } from '../components/TouchNumber';
import { EotTelegraph } from '../components/EotTelegraph';
import { RadarScope } from '../components/RadarScope';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

export function StationPage() {
  const { gameId = '', accessToken = '', stationId = '' } = useParams();
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(() =>
    getAuthToken(tokenKey(gameId, accessToken, stationId)),
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
  const faction = vessel?.unit.faction;
  const sideAccent =
    faction === 'Blue' || faction === 'Red' || faction === 'Civilian'
      ? faction.toLowerCase()
      : vessel?.unit.side === 'blue' || vessel?.unit.side === 'red'
        ? vessel.unit.side
        : 'neutral';

  useEffect(() => {
    if (!vessel || seeded) return;
    setSeeded(true);
    setCourse(Math.round(vessel.unit.orders.course ?? vessel.unit.orderedCourse ?? vessel.unit.heading));
    setEot(vessel.unit.orders.eot ?? vessel.unit.eot);
  }, [vessel, seeded]);

  const caps = useMemo(() => new Set(vessel?.station.capabilities ?? []), [vessel]);
  const canHelm = caps.has('helm');
  const canEot = caps.has('engineering') || caps.has('helm');
  const canRadar = caps.has('radar');
  const stubCaps = [...caps].filter(
    (c) => c !== 'helm' && c !== 'engineering' && c !== 'radar',
  );

  const login = async (e?: FormEvent) => {
    e?.preventDefault();
    setAuthError(null);
    try {
      const auth = await api.authVessel(gameId, {
        accessToken,
        password: password || undefined,
        stationId,
      });
      setAuthToken(tokenKey(gameId, accessToken, stationId), auth.token);
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
      <CrtShell>
        <div className="app-shell">
          <span className="brand-mark">Station join</span>
          <p className="brand">War Patrol</p>
          <p className="subhead">
            Vessel <span className="mono">{accessToken}</span> · station{' '}
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
      </CrtShell>
    );
  }

  return (
    <CrtShell side={sideAccent as 'blue' | 'red' | 'civilian' | 'neutral'} faction={faction}>
      <div className="app-shell">
        <header className="header-bar">
          <div>
            <span className="brand-mark">Station console</span>
            <p className="brand" style={{ fontSize: 'clamp(1.35rem, 3.5vw, 1.85rem)' }}>
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
            {vessel && (
              <span className={`side-badge side-badge--${sideAccent}`}>
                {faction ?? vessel.unit.side}
              </span>
            )}
          </div>
          <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <span className={`live-dot ${connected ? '' : 'off'}`} />
              <span className="mono muted">{connected ? 'LIVE' : 'RECONNECTING'}</span>
              <span className="mono muted">v{stateVersion}</span>
            </div>
          </div>
        </header>

        {(error || actionError) && <p className="error">{error || actionError}</p>}

        {vessel && (
          <>
            <section className="panel stack">
              <h2>Turn</h2>
              <TurnStatus turn={vessel.turn} turnLengthSeconds={vessel.turnLengthSeconds} />
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

            {canRadar && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Radar · PPI</h2>
                  <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
                    Call contacts by true bearing on the rim. Raw sensor picture only — no friend/foe identity.
                    {vessel.radarUnavailableReason === 'submerged'
                      ? ''
                      : vessel.radarOperational
                        ? ` Surface search · ${vessel.radarMaxRangeNm ?? 25} nm.`
                        : vessel.radarUnavailableReason === 'no_sensor'
                          ? ' No radar set installed on this vessel.'
                          : vessel.radarUnavailableReason === 'sunk'
                            ? ' Set offline — unit sunk/destroyed.'
                            : vessel.radarUnavailableReason === 'sensors_disabled'
                              ? ' Sensors disabled.'
                              : ''}
                  </p>
                </div>
                {vessel.radarOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {vessel.radarUnavailableReason === 'submerged'
                        ? 'Radar unavailable — submerged'
                        : vessel.radarUnavailableReason === 'sunk'
                          ? 'Radar unavailable — sunk/destroyed'
                          : vessel.radarUnavailableReason === 'sensors_disabled'
                            ? 'Radar unavailable — sensors disabled'
                            : vessel.radarUnavailableReason === 'no_sensor'
                              ? 'Radar unavailable — no sensor'
                              : 'Radar unavailable'}
                    </p>
                    <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                      {vessel.radarUnavailableReason === 'submerged'
                        ? 'Surface (depth ≤ 5 m) to energize the set and paint contacts. Submerged hulls also do not return echoes to other radars.'
                        : vessel.radarUnavailableReason === 'sensors_disabled'
                          ? 'Repair or re-enable the sensors subsystem to restore the PPI.'
                          : vessel.radarUnavailableReason === 'sunk'
                            ? 'This unit no longer contributes to the sensor picture.'
                            : 'This station has no usable radar picture.'}
                    </p>
                  </div>
                ) : (
                  <RadarScope
                    contacts={vessel.radarContacts ?? []}
                    maxRangeNm={vessel.radarMaxRangeNm ?? 25}
                    ownHeading={vessel.unit.heading}
                  />
                )}
              </section>
            )}

            <div className="grid-2" style={{ marginTop: '1rem' }}>
              <section className="panel">
                <h2>Own ship readouts</h2>
                <table className="table mono">
                  <tbody>
                    <tr>
                      <th>Faction</th>
                      <td className="readout">{vessel.unit.faction}</td>
                    </tr>
                    <tr>
                      <th>Type</th>
                      <td className="readout">{vessel.unit.type}</td>
                    </tr>
                    <tr>
                      <th>Class</th>
                      <td className="readout">{vessel.unit.class}</td>
                    </tr>
                    <tr>
                      <th>Condition</th>
                      <td className="readout">
                        {conditionLabel(vessel.unit.type, vessel.unit.condition)}
                      </td>
                    </tr>
                    <tr>
                      <th>Propulsion</th>
                      <td className="readout">{vessel.unit.subsystems.propulsion}</td>
                    </tr>
                    <tr>
                      <th>Sensors</th>
                      <td className="readout">{vessel.unit.subsystems.sensors}</td>
                    </tr>
                    {vessel.unit.type === 'Aircraft' && (
                      <tr>
                        <th>Flight level</th>
                        <td className="readout">{vessel.unit.flightLevel ?? 'medium'}</td>
                      </tr>
                    )}
                    {vessel.unit.type === 'Submarine' && (
                      <tr>
                        <th>Depth</th>
                        <td className="readout">{vessel.unit.position.depth.toFixed(0)} m</td>
                      </tr>
                    )}
                    <tr>
                      <th>Lat</th>
                      <td className="readout">{vessel.unit.position.lat.toFixed(4)}</td>
                    </tr>
                    <tr>
                      <th>Lon</th>
                      <td className="readout">{vessel.unit.position.lon.toFixed(4)}</td>
                    </tr>
                    <tr>
                      <th>Heading</th>
                      <td className="readout">{vessel.unit.heading.toFixed(0)}°</td>
                    </tr>
                    <tr>
                      <th>Ordered course</th>
                      <td className="readout">{vessel.unit.orderedCourse.toFixed(0)}°</td>
                    </tr>
                    <tr>
                      <th>Speed</th>
                      <td className="readout">{vessel.unit.speed.toFixed(1)} kn</td>
                    </tr>
                    <tr>
                      <th>Turn rate</th>
                      <td className="readout">
                        {vessel.unit.turnRate.toFixed(0)}°/min · {vessel.unit.radarSignature}
                      </td>
                    </tr>
                    <tr>
                      <th>EOT</th>
                      <td className="readout">{EOT_LABELS[vessel.unit.eot]}</td>
                    </tr>
                    <tr>
                      <th>Pending</th>
                      <td className="readout">
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
                    <TouchNumber
                      label="Ordered / steering course"
                      value={course}
                      onChange={setCourse}
                      min={0}
                      max={359}
                      step={1}
                      wrap
                      unit="°"
                      disabled={!vessel.canSubmitOrders}
                      format={(v) => `${String(v).padStart(3, '0')}°`}
                    />
                    <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
                      Current heading {vessel.unit.heading.toFixed(0)}° · ship turns toward ordered course
                      each resolve ({vessel.unit.turnRate.toFixed(0)}°/min).
                    </p>
                    <div className="control-actions">
                      <button
                        className="primary"
                        type="button"
                        disabled={!vessel.canSubmitOrders}
                        onClick={() => void submit({ course })}
                      >
                        Submit course
                      </button>
                    </div>
                  </section>
                )}

                {canEot && (
                  <section className="panel stack">
                    <h2>Engine order telegraph</h2>
                    <EotTelegraph
                      value={eot}
                      onChange={setEot}
                      disabled={!vessel.canSubmitOrders}
                    />
                    <div className="control-actions">
                      <button
                        className="primary"
                        type="button"
                        disabled={!vessel.canSubmitOrders}
                        onClick={() => void submit({ eot })}
                      >
                        Ring up EOT
                      </button>
                    </div>
                  </section>
                )}

                {stubCaps.length > 0 && (
                  <section className="panel">
                    <h2>Other stations (stub)</h2>
                    <p className="muted" style={{ marginTop: 0 }}>
                      Capability panels deferred:
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
    </CrtShell>
  );
}
