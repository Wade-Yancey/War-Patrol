import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  EOT_LABELS,
  PERISCOPE_DEPTH_M,
  SUBMARINE_MAX_DEPTH_M,
  conditionLabel,
  effectiveMaxSpeed,
  formatDepthMeters,
  formatPendingOrdersSummary,
  hasPendingOrders,
  isRadarSurfaced,
  type EotSetting,
  type VesselView,
} from '@war-patrol/shared';
import { api } from '../api/client';
import { getAuthToken, setAuthToken } from '../api/authStorage';
import { useGameStream } from '../hooks/useGameStream';
import { TurnStatus } from '../components/TurnStatus';
import { CrtShell } from '../components/CrtShell';
import { TouchNumber } from '../components/TouchNumber';
import { EotTelegraph } from '../components/EotTelegraph';
import { HelmCompass } from '../components/HelmCompass';
import { DiveControls } from '../components/DiveControls';
import { HydrophoneScope } from '../components/HydrophoneScope';
import { PeriscopeScope } from '../components/PeriscopeScope';
import { RadarScope } from '../components/RadarScope';
import { ActiveSonarScope } from '../components/ActiveSonarScope';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

type SensorTab = 'radar' | 'hydrophone' | 'sonar' | 'periscope';

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
  const [depth, setDepth] = useState(0);
  const [seeded, setSeeded] = useState(false);
  const [sensorTab, setSensorTab] = useState<SensorTab | null>(null);
  const [sonarBusy, setSonarBusy] = useState(false);

  const { view, stateVersion, connected, error } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
  });

  const vessel = view?.role === 'vessel' ? (view as VesselView) : null;
  const faction = vessel?.unit.faction;
  const speedCeiling = vessel
    ? effectiveMaxSpeed({
        type: vessel.unit.type,
        maxSpeed: vessel.unit.maxSpeed,
        depth: vessel.unit.position.depth,
      })
    : 0;
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
    setDepth(
      Math.round(
        vessel.unit.orders.depth ?? vessel.unit.orderedDepth ?? vessel.unit.position.depth,
      ),
    );
  }, [vessel, seeded]);

  const caps = useMemo(() => new Set(vessel?.station.capabilities ?? []), [vessel]);
  const isControls = stationId === 'controls' || caps.has('helm') || caps.has('engineering');
  const isSensors =
    stationId === 'sensors' ||
    caps.has('radar') ||
    caps.has('hydrophone') ||
    caps.has('active_sonar') ||
    caps.has('lookout');
  const canHelm = caps.has('helm');
  const canEot = caps.has('engineering') || caps.has('helm');
  const canRadar = caps.has('radar');
  const canHydrophone = caps.has('hydrophone');
  const canActiveSonar = caps.has('active_sonar');
  const canPeriscope = caps.has('lookout');
  const sensorFocus =
    isSensors && (canRadar || canHydrophone || canActiveSonar || canPeriscope);

  const surfaced = vessel ? isRadarSurfaced(vessel.unit.position) : true;
  const depthM = vessel?.unit.position.depth ?? 0;
  const atPeriscopeDepth = depthM <= PERISCOPE_DEPTH_M;

  // Sub Sensors: pick a sensible default tab from depth; follow depth-band changes.
  useEffect(() => {
    if (!vessel || !isSensors) return;
    if (canHydrophone && canRadar) {
      const preferred: SensorTab = surfaced
        ? 'radar'
        : canPeriscope && atPeriscopeDepth
          ? 'periscope'
          : 'hydrophone';
      setSensorTab((prev) => {
        if (prev === 'radar' || prev === 'hydrophone' || prev === 'periscope') {
          if (surfaced && (prev === 'hydrophone' || prev === 'periscope')) return 'radar';
          if (!surfaced && prev === 'radar') {
            return canPeriscope && atPeriscopeDepth ? 'periscope' : 'hydrophone';
          }
          // Crossing periscope ↔ deep: nudge away from unavailable optics / toward hydro.
          if (!surfaced && prev === 'periscope' && !atPeriscopeDepth) return 'hydrophone';
          if (!surfaced && prev === 'hydrophone' && canPeriscope && atPeriscopeDepth && depthM > 5) {
            // Stay on hydro unless we just entered the band with no prior choice — keep selection.
            return prev;
          }
          return prev;
        }
        return preferred;
      });
      return;
    }
    if (canActiveSonar && canRadar) {
      setSensorTab((prev) => prev ?? 'radar');
      return;
    }
    if (canRadar) setSensorTab('radar');
    else if (canPeriscope) setSensorTab('periscope');
    else if (canHydrophone) setSensorTab('hydrophone');
    else if (canActiveSonar) setSensorTab('sonar');
  }, [
    vessel,
    isSensors,
    canHydrophone,
    canRadar,
    canActiveSonar,
    canPeriscope,
    surfaced,
    atPeriscopeDepth,
    depthM,
  ]);

  const activeTab: SensorTab =
    sensorTab ??
    (canRadar
      ? 'radar'
      : canPeriscope
        ? 'periscope'
        : canHydrophone
          ? 'hydrophone'
          : 'sonar');

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

  const submit = async (patch: { course?: number; eot?: EotSetting; depth?: number }) => {
    if (!token) return;
    setActionError(null);
    try {
      await api.orders(gameId, token, patch);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Order failed');
    }
  };

  const toggleActiveSonar = async (enabled: boolean) => {
    if (!token) return;
    setActionError(null);
    setSonarBusy(true);
    try {
      await api.setActiveSonar(gameId, token, enabled);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Sonar toggle failed');
    } finally {
      setSonarBusy(false);
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
      <div className={`app-shell${vessel && sensorFocus ? ' app-shell--radar-focus' : ''}`}>
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
              <span className={`mono muted`}>{connected ? 'LIVE' : 'RECONNECTING'}</span>
              <span className="mono muted">v{stateVersion}</span>
            </div>
          </div>
        </header>

        {(error || actionError) && <p className="error">{error || actionError}</p>}

        {vessel && isSensors && (
          <>
            {(canRadar && canHydrophone) ||
            (canRadar && canActiveSonar) ||
            (canRadar && canPeriscope) ||
            (canHydrophone && canPeriscope) ? (
              <div className="sensor-tabs" role="tablist" aria-label="Sensor instruments">
                {canRadar && (
                  <button
                    type="button"
                    role="tab"
                    className={activeTab === 'radar' ? 'primary' : undefined}
                    aria-selected={activeTab === 'radar'}
                    onClick={() => setSensorTab('radar')}
                  >
                    Radar
                  </button>
                )}
                {canPeriscope && (
                  <button
                    type="button"
                    role="tab"
                    className={activeTab === 'periscope' ? 'primary' : undefined}
                    aria-selected={activeTab === 'periscope'}
                    onClick={() => setSensorTab('periscope')}
                  >
                    Periscope
                  </button>
                )}
                {canHydrophone && (
                  <button
                    type="button"
                    role="tab"
                    className={activeTab === 'hydrophone' ? 'primary' : undefined}
                    aria-selected={activeTab === 'hydrophone'}
                    onClick={() => setSensorTab('hydrophone')}
                  >
                    Hydrophone
                  </button>
                )}
                {canActiveSonar && (
                  <button
                    type="button"
                    role="tab"
                    className={activeTab === 'sonar' ? 'primary' : undefined}
                    aria-selected={activeTab === 'sonar'}
                    onClick={() => setSensorTab('sonar')}
                  >
                    Active sonar
                  </button>
                )}
              </div>
            ) : null}

            {canRadar &&
              (activeTab === 'radar' ||
                (!canHydrophone && !canActiveSonar && !canPeriscope)) && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Radar · PPI</h2>
                  <p className="muted radar-station-blurb">
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

            {canPeriscope && activeTab === 'periscope' && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Periscope · Visual</h2>
                  <p className="muted radar-station-blurb">
                    Short-range silhouettes only — relative bearing and approximate speed.
                    {vessel.periscopeOperational
                      ? ` Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · usable depth ≤ ${PERISCOPE_DEPTH_M} m.`
                      : vessel.periscopeUnavailableReason === 'too_deep'
                        ? ` Depth ≤ ${PERISCOPE_DEPTH_M} m (periscope / surface) required.`
                        : vessel.periscopeUnavailableReason === 'no_sensor'
                          ? ' No lookout/periscope set installed.'
                          : vessel.periscopeUnavailableReason === 'sunk'
                            ? ' Set offline — unit sunk/destroyed.'
                            : vessel.periscopeUnavailableReason === 'sensors_disabled'
                              ? ' Sensors disabled.'
                              : ''}
                  </p>
                </div>
                {vessel.periscopeOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {vessel.periscopeUnavailableReason === 'too_deep'
                        ? 'Periscope unavailable — too deep'
                        : vessel.periscopeUnavailableReason === 'sunk'
                          ? 'Periscope unavailable — sunk/destroyed'
                          : vessel.periscopeUnavailableReason === 'sensors_disabled'
                            ? 'Periscope unavailable — sensors disabled'
                            : vessel.periscopeUnavailableReason === 'no_sensor'
                              ? 'Periscope unavailable — no sensor'
                              : 'Periscope unavailable'}
                    </p>
                    <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                      {vessel.periscopeUnavailableReason === 'too_deep'
                        ? `Come up to periscope depth or shallower (≤ ${PERISCOPE_DEPTH_M} m) to raise optics.`
                        : 'This station has no usable periscope picture.'}
                    </p>
                  </div>
                ) : (
                  <PeriscopeScope
                    contacts={vessel.periscopeContacts ?? []}
                    maxRangeNm={vessel.periscopeMaxRangeNm ?? 6}
                    ownHeading={vessel.unit.heading}
                  />
                )}
              </section>
            )}

            {canHydrophone && activeTab === 'hydrophone' && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Hydrophone · Bearing listen</h2>
                  <p className="muted radar-station-blurb">
                    Train the needle by ear — no visual contacts. Underway propellers and active-sonar pings;
                    volume falls with range and misalignment.
                    {vessel.hydrophoneOperational
                      ? ` Passive · ${vessel.hydrophoneMaxRangeNm ?? 30} nm.`
                      : vessel.hydrophoneUnavailableReason === 'surfaced'
                        ? ' Submerged only (depth &gt; 5 m).'
                        : vessel.hydrophoneUnavailableReason === 'no_sensor'
                          ? ' No hydrophone set installed.'
                          : vessel.hydrophoneUnavailableReason === 'sunk'
                            ? ' Set offline — unit sunk/destroyed.'
                            : vessel.hydrophoneUnavailableReason === 'sensors_disabled'
                              ? ' Sensors disabled.'
                              : ''}
                  </p>
                </div>
                {vessel.hydrophoneOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {vessel.hydrophoneUnavailableReason === 'surfaced'
                        ? 'Hydrophone unavailable — surfaced'
                        : vessel.hydrophoneUnavailableReason === 'sunk'
                          ? 'Hydrophone unavailable — sunk/destroyed'
                          : vessel.hydrophoneUnavailableReason === 'sensors_disabled'
                            ? 'Hydrophone unavailable — sensors disabled'
                            : vessel.hydrophoneUnavailableReason === 'no_sensor'
                              ? 'Hydrophone unavailable — no sensor'
                              : 'Hydrophone unavailable'}
                    </p>
                    <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                      {vessel.hydrophoneUnavailableReason === 'surfaced'
                        ? 'Dive below 5 m to listen. No hydrophone on the surface.'
                        : 'This station has no usable hydrophone picture.'}
                    </p>
                  </div>
                ) : (
                  <HydrophoneScope
                    contacts={vessel.hydrophoneContacts ?? []}
                    maxRangeNm={vessel.hydrophoneMaxRangeNm ?? 30}
                    ownHeading={vessel.unit.heading}
                  />
                )}
              </section>
            )}

            {canActiveSonar && activeTab === 'sonar' && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Active search sonar</h2>
                  <p className="muted radar-station-blurb">
                    Forward cone only (±{vessel.sonarHalfAngleDeg ?? 30}° about heading). Toggle search to
                    ping and paint anonymous contacts inside the cone.
                    {vessel.sonarMaxRangeNm ? ` Max ${vessel.sonarMaxRangeNm} nm.` : ''}
                  </p>
                </div>
                <div className="sonar-toggle-row">
                  <button
                    type="button"
                    className={vessel.unit.activeSonarEnabled ? 'primary' : undefined}
                    disabled={
                      sonarBusy ||
                      vessel.sonarUnavailableReason === 'no_sensor' ||
                      vessel.sonarUnavailableReason === 'sunk' ||
                      vessel.sonarUnavailableReason === 'sensors_disabled'
                    }
                    aria-pressed={vessel.unit.activeSonarEnabled}
                    onClick={() => void toggleActiveSonar(!vessel.unit.activeSonarEnabled)}
                  >
                    {vessel.unit.activeSonarEnabled ? 'Search sonar ON' : 'Search sonar OFF'}
                  </button>
                  <span className="mono muted">
                    {vessel.unit.activeSonarEnabled ? 'PINGING' : 'STANDBY'}
                  </span>
                </div>
                {vessel.sonarUnavailableReason === 'no_sensor' ||
                vessel.sonarUnavailableReason === 'sunk' ||
                vessel.sonarUnavailableReason === 'sensors_disabled' ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {vessel.sonarUnavailableReason === 'sunk'
                        ? 'Sonar unavailable — sunk/destroyed'
                        : vessel.sonarUnavailableReason === 'sensors_disabled'
                          ? 'Sonar unavailable — sensors disabled'
                          : 'Sonar unavailable — no sensor'}
                    </p>
                  </div>
                ) : vessel.sonarOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      Active sonar standby — toggle ON to search
                    </p>
                    <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                      No blips while the set is off. Pings are audible to listening hydrophones when ON.
                    </p>
                  </div>
                ) : (
                  <ActiveSonarScope
                    contacts={vessel.sonarContacts ?? []}
                    maxRangeNm={vessel.sonarMaxRangeNm ?? 8}
                    halfAngleDeg={vessel.sonarHalfAngleDeg ?? 30}
                    ownHeading={vessel.unit.heading}
                    pinging={Boolean(vessel.unit.activeSonarEnabled)}
                  />
                )}
              </section>
            )}

            {/* Turn status under sensor instruments */}

            <section className="panel stack station-turn-panel">
              <h2>Turn</h2>
              <TurnStatus turn={vessel.turn} turnLengthSeconds={vessel.turnLengthSeconds} />
              {hasPendingOrders(vessel.unit.orders) ? (
                <div className="orders-of-record" role="status">
                  <span className="status-pill open">Of record</span>
                  <span className="mono readout">{formatPendingOrdersSummary(vessel.unit.orders)}</span>
                  {vessel.unit.orders.updatedByStationId && (
                    <span className="mono muted">via {vessel.unit.orders.updatedByStationId}</span>
                  )}
                </div>
              ) : (
                <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
                  No pending orders filed for this turn.
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
          </>
        )}

        {vessel && isControls && !isSensors && (
          <div className="controls-station">
            <section className="panel stack controls-helm-panel">
              <div className="controls-section-head">
                <h2>Helm</h2>
                <p className="muted controls-section-blurb">
                  Gyro compass dominates — set course with the dial controls, then submit.
                </p>
              </div>
              {canHelm && (
                <>
                  <HelmCompass
                    heading={vessel.unit.heading}
                    orderedCourse={vessel.unit.orderedCourse}
                    draftCourse={course}
                    turnRate={vessel.unit.turnRate}
                  />
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
                </>
              )}
            </section>

            {canHelm && vessel.unit.type === 'Submarine' && (
              <section className="panel stack controls-dive-panel">
                <div className="controls-section-head">
                  <h2>Dive</h2>
                  <p className="muted controls-section-blurb">
                    Preset depths or set meters directly. Ships have no dive UI.
                  </p>
                </div>
                <DiveControls
                  depth={vessel.unit.position.depth}
                  orderedDepth={vessel.unit.orderedDepth ?? vessel.unit.position.depth}
                  draftDepth={depth}
                  onDraftDepthChange={setDepth}
                  maxDepthM={SUBMARINE_MAX_DEPTH_M}
                  disabled={!vessel.canSubmitOrders}
                  onSubmit={(d) => void submit({ depth: d })}
                />
              </section>
            )}

            {canEot && (
              <section className="panel stack controls-eot-panel">
                <div className="controls-section-head">
                  <h2>Engine order telegraph</h2>
                  <p className="muted controls-section-blurb">
                    Ring up a bell — acknowledged on resolve; hull speed ramps.
                  </p>
                </div>
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

            <section className="panel controls-status-strip" aria-label="Own ship status">
              <div className="controls-status-grid">
                <div className="controls-status-item">
                  <span className="controls-status-key">HDG</span>
                  <span className="readout">{Math.round(vessel.unit.heading).toString().padStart(3, '0')}°</span>
                </div>
                <div className="controls-status-item">
                  <span className="controls-status-key">CRS</span>
                  <span className="readout">
                    {Math.round(vessel.unit.orderedCourse).toString().padStart(3, '0')}°
                  </span>
                </div>
                <div className="controls-status-item">
                  <span className="controls-status-key">SPD</span>
                  <span className="readout">
                    {vessel.unit.speed.toFixed(1)}
                    <span className="muted" style={{ marginLeft: 4, fontSize: '0.75em' }}>
                      /{speedCeiling.toFixed(0)} kn
                    </span>
                  </span>
                </div>
                <div className="controls-status-item">
                  <span className="controls-status-key">EOT</span>
                  <span className="readout">{EOT_LABELS[vessel.unit.eot]}</span>
                </div>
                {vessel.unit.type === 'Submarine' && (
                  <div className="controls-status-item">
                    <span className="controls-status-key">DPT</span>
                    <span className="readout">
                      {formatDepthMeters(vessel.unit.position.depth)}
                      {Math.round(vessel.unit.orderedDepth ?? vessel.unit.position.depth) !==
                        Math.round(vessel.unit.position.depth) && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: '0.75em' }}>
                          → {formatDepthMeters(vessel.unit.orderedDepth ?? 0)}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <div className="controls-status-item controls-status-item--wide">
                  <span className="controls-status-key">ORD</span>
                  <span className="readout">{formatPendingOrdersSummary(vessel.unit.orders)}</span>
                </div>
              </div>
            </section>

            <section className="panel stack station-turn-panel">
              <h2>Turn</h2>
              <TurnStatus turn={vessel.turn} turnLengthSeconds={vessel.turnLengthSeconds} />
              {hasPendingOrders(vessel.unit.orders) ? (
                <div className="orders-of-record" role="status">
                  <span className="status-pill open">Of record</span>
                  <span className="mono readout">{formatPendingOrdersSummary(vessel.unit.orders)}</span>
                  {vessel.unit.orders.updatedByStationId && (
                    <span className="mono muted">via {vessel.unit.orders.updatedByStationId}</span>
                  )}
                </div>
              ) : (
                <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
                  No pending orders filed for this turn.
                </p>
              )}
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

            <details className="panel controls-ownship-details">
              <summary>Own ship details</summary>
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
                      <td className="readout">{formatDepthMeters(vessel.unit.position.depth)}</td>
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
                    <th>Turn rate</th>
                    <td className="readout">
                      {vessel.unit.turnRate.toFixed(0)}°/min · {vessel.unit.radarSignature}
                    </td>
                  </tr>
                </tbody>
              </table>
            </details>

            <p className="muted controls-ambient-note">
              Ambient bridge audio (nearby depth charges / sonar via BT speakers) planned for this
              screen later — not in this build.
            </p>
          </div>
        )}
      </div>
    </CrtShell>
  );
}
