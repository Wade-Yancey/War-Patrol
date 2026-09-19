import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  type DepthChargeDropOrder,
  type EotSetting,
  type TorpedoFireOrder,
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
import { TorpedoCalculator } from '../components/TorpedoCalculator';
import { DepthChargeControls } from '../components/DepthChargeControls';
import { DamageReportPanel } from '../components/DamageReportPanel';
import {
  DEPTH_CHARGE_CONTROLS_GAIN,
  loadDepthChargeBuffer,
  playDepthChargeSample,
} from '../audio/depthCharge';
import {
  CONTROLS_AMBIENT_GAIN,
  loadControlsAmbientBuffer,
  startControlsAmbientLoop,
} from '../audio/controlsAmbient';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

type SensorTab = 'radar' | 'hydrophone' | 'sonar' | 'periscope';
type ControlsTab = 'helm' | 'weapons' | 'damage' | 'eot';

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
  const [controlsTab, setControlsTab] = useState<ControlsTab>('helm');
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
  const canWeapons = caps.has('weapons') || caps.has('torpedo');
  const canTorpedo =
    canWeapons && (vessel?.unit.type === 'Submarine' || caps.has('torpedo'));
  const canDepthCharges = canWeapons && vessel?.unit.class === 'Destroyer';
  /** Surface ships use lookout (always available); subs use depth-gated periscope. */
  const opticsVariant: 'periscope' | 'lookout' =
    vessel?.unit.type === 'Submarine' ? 'periscope' : 'lookout';
  const opticsTabLabel = opticsVariant === 'lookout' ? 'Lookout' : 'Periscope';
  const sensorFocus =
    isSensors && (canRadar || canHydrophone || canActiveSonar || canPeriscope);

  const onControlsBridge = Boolean(vessel) && isControls && !isSensors;

  const playedBridgeDcRef = useRef<Set<string>>(new Set());
  const pendingBridgeDcRef = useRef<
    Array<{ id: string; rangeNm: number }>
  >([]);
  const bridgeAudioRef = useRef<{
    ctx: AudioContext | null;
    buffer: AudioBuffer | null;
    ambientBuffer: AudioBuffer | null;
    ambientSource: AudioBufferSourceNode | null;
    ambientGain: GainNode | null;
  }>({
    ctx: null,
    buffer: null,
    ambientBuffer: null,
    ambientSource: null,
    ambientGain: null,
  });

  const ensureBridgeAudioCtx = async (): Promise<AudioContext> => {
    if (!bridgeAudioRef.current.ctx || bridgeAudioRef.current.ctx.state === 'closed') {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      bridgeAudioRef.current.ctx = new Ctx();
      bridgeAudioRef.current.buffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
    }
    const ctx = bridgeAudioRef.current.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  };

  /** Play any queued close-aboard DC one-shots (range-based; never firer-filtered). */
  const flushBridgeDcAudio = async (): Promise<void> => {
    const pending = pendingBridgeDcRef.current;
    if (!pending.length) return;
    const ctx = await ensureBridgeAudioCtx();
    if (ctx.state !== 'running') return;
    if (!bridgeAudioRef.current.buffer) {
      bridgeAudioRef.current.buffer = await loadDepthChargeBuffer(ctx);
    }
    const buffer = bridgeAudioRef.current.buffer;
    if (!buffer) return;
    const still: Array<{ id: string; rangeNm: number }> = [];
    for (const e of pending) {
      if (playedBridgeDcRef.current.has(e.id)) continue;
      try {
        const proximity = Math.max(0.15, 1 - e.rangeNm / 0.6);
        playDepthChargeSample(
          ctx,
          buffer,
          ctx.destination,
          DEPTH_CHARGE_CONTROLS_GAIN * proximity,
        );
        playedBridgeDcRef.current.add(e.id);
      } catch {
        still.push(e);
      }
    }
    pendingBridgeDcRef.current = still;
  };

  // Controls ambient bed: quiet looping facility hum (BT speakers). Stop on leave.
  useEffect(() => {
    if (!onControlsBridge) return;
    let cancelled = false;
    let starting = false;

    const stopAmbient = () => {
      const voice = bridgeAudioRef.current;
      if (voice.ambientSource) {
        try {
          voice.ambientSource.stop();
        } catch {
          /* already stopped */
        }
        try {
          voice.ambientSource.disconnect();
          voice.ambientGain?.disconnect();
        } catch {
          /* ignore */
        }
        voice.ambientSource = null;
        voice.ambientGain = null;
      }
    };

    const startAmbient = async () => {
      if (cancelled || bridgeAudioRef.current.ambientSource || starting) return;
      starting = true;
      try {
        const ctx = await ensureBridgeAudioCtx();
        if (cancelled || bridgeAudioRef.current.ambientSource) return;
        if (!bridgeAudioRef.current.ambientBuffer) {
          bridgeAudioRef.current.ambientBuffer = await loadControlsAmbientBuffer(ctx);
        }
        if (cancelled || bridgeAudioRef.current.ambientSource) return;
        const { source, gain } = startControlsAmbientLoop(
          ctx,
          bridgeAudioRef.current.ambientBuffer,
          ctx.destination,
          CONTROLS_AMBIENT_GAIN,
        );
        bridgeAudioRef.current.ambientSource = source;
        bridgeAudioRef.current.ambientGain = gain;
        // Same gesture / unlock also drains pending DC one-shots.
        await flushBridgeDcAudio();
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      } catch {
        /* autoplay / sample — ignore; unlock listeners may retry */
      } finally {
        starting = false;
      }
    };

    const unlock = () => {
      void startAmbient();
      void flushBridgeDcAudio();
    };

    void startAmbient();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      stopAmbient();
      const ctx = bridgeAudioRef.current.ctx;
      bridgeAudioRef.current.ctx = null;
      bridgeAudioRef.current.buffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
      // Closed ctx → allow replay after remount (React Strict Mode / leave+rejoin).
      playedBridgeDcRef.current.clear();
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [onControlsBridge]);

  // Controls bridge: queue + play depth-charge WAV for every close blast (any firer).
  useEffect(() => {
    if (!onControlsBridge || !vessel) return;
    const events = vessel.bridgeDetonations ?? [];
    const live = new Set(events.map((e) => e.id));
    for (const id of [...playedBridgeDcRef.current]) {
      if (!live.has(id)) playedBridgeDcRef.current.delete(id);
    }
    pendingBridgeDcRef.current = events
      .filter((e) => !playedBridgeDcRef.current.has(e.id))
      .map((e) => ({ id: e.id, rangeNm: e.rangeNm }));
    if (!pendingBridgeDcRef.current.length) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await flushBridgeDcAudio();
    })();
    return () => {
      cancelled = true;
    };
  }, [onControlsBridge, vessel, vessel?.bridgeDetonations, vessel?.stateVersion]);

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

  const submit = async (
    patch: {
      course?: number;
      eot?: EotSetting;
      depth?: number;
      fireTorpedo?: TorpedoFireOrder | null;
      dropDepthCharges?: DepthChargeDropOrder | null;
    },
  ) => {
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
            (canActiveSonar && canPeriscope) ||
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
                    {opticsTabLabel}
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
                  <h2>
                    {opticsVariant === 'lookout' ? 'Lookout · Visual' : 'Periscope · Visual'}
                  </h2>
                  <p className="muted radar-station-blurb">
                    Short-range silhouettes only — relative bearing and approximate speed.
                    {vessel.periscopeOperational
                      ? opticsVariant === 'lookout'
                        ? ` Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · bridge lookout.`
                        : ` Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · usable depth ≤ ${PERISCOPE_DEPTH_M} m.`
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
                          ? `${opticsTabLabel} unavailable — sunk/destroyed`
                          : vessel.periscopeUnavailableReason === 'sensors_disabled'
                            ? `${opticsTabLabel} unavailable — sensors disabled`
                            : vessel.periscopeUnavailableReason === 'no_sensor'
                              ? `${opticsTabLabel} unavailable — no sensor`
                              : `${opticsTabLabel} unavailable`}
                    </p>
                    <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                      {vessel.periscopeUnavailableReason === 'too_deep'
                        ? `Come up to periscope depth or shallower (≤ ${PERISCOPE_DEPTH_M} m) to raise optics.`
                        : `This station has no usable ${opticsVariant === 'lookout' ? 'lookout' : 'periscope'} picture.`}
                    </p>
                  </div>
                ) : (
                  <>
                    <PeriscopeScope
                      contacts={vessel.periscopeContacts ?? []}
                      maxRangeNm={vessel.periscopeMaxRangeNm ?? 6}
                      ownHeading={vessel.unit.heading}
                      variant={opticsVariant}
                    />
                    {(vessel.torpedoWakeCues?.length ?? 0) > 0 && (
                      <div className="wake-cues panel" role="status">
                        <h3 className="mono" style={{ margin: '0 0 0.35rem', fontSize: '0.9rem' }}>
                          Wake sighting (FoW)
                        </h3>
                        <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.8rem' }}>
                          Possible torpedo wake direction — not a firm ID.
                        </p>
                        <ul className="mono" style={{ margin: 0, paddingLeft: '1.2rem' }}>
                          {vessel.torpedoWakeCues!.map((w) => (
                            <li key={w.id}>
                              {w.confidence.toUpperCase()} · wake travel{' '}
                              {w.relativeBearing === 0
                                ? 'dead ahead'
                                : `${Math.abs(w.relativeBearing)}° ${w.relativeBearing > 0 ? 'stbd' : 'port'}`}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {canHydrophone && activeTab === 'hydrophone' && (
              <section className="panel stack radar-station-panel">
                <div className="radar-station-head">
                  <h2>Hydrophone · Bearing listen</h2>
                  <p className="muted radar-station-blurb">
                    Train the needle by ear — no visual contacts. Underway propellers, active-sonar
                    pings, and depth-charge detonations; volume falls with range and misalignment.
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
            <section className="panel controls-status-strip" aria-label="Own ship status">
              {(vessel.bridgeDetonations?.length ?? 0) > 0 && (
                <div className="controls-bridge-dc-alert" role="status" aria-live="assertive">
                  <span className="controls-bridge-dc-alert-key">BRIDGE</span>
                  <span className="readout">
                    DEPTH CHARGE close aboard — {vessel.bridgeDetonations!.length} blast
                    {vessel.bridgeDetonations!.length === 1 ? '' : 's'} within ~
                    {Math.max(
                      ...vessel.bridgeDetonations!.map((d) => d.rangeNm),
                    ).toFixed(2)}{' '}
                    nm (own ship FoW — any firer)
                  </span>
                </div>
              )}
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

            <div className="sensor-tabs" role="tablist" aria-label="Controls instruments">
              <button
                type="button"
                role="tab"
                className={controlsTab === 'helm' ? 'primary' : undefined}
                aria-selected={controlsTab === 'helm'}
                onClick={() => setControlsTab('helm')}
              >
                Helm{vessel.unit.type === 'Submarine' ? ' / Dive' : ''}
              </button>
              {(canTorpedo || canDepthCharges) && (
                <button
                  type="button"
                  role="tab"
                  className={controlsTab === 'weapons' ? 'primary' : undefined}
                  aria-selected={controlsTab === 'weapons'}
                  onClick={() => setControlsTab('weapons')}
                >
                  Weapons
                </button>
              )}
              <button
                type="button"
                role="tab"
                className={controlsTab === 'damage' ? 'primary' : undefined}
                aria-selected={controlsTab === 'damage'}
                onClick={() => setControlsTab('damage')}
              >
                Damage
              </button>
              {canEot && (
                <button
                  type="button"
                  role="tab"
                  className={controlsTab === 'eot' ? 'primary' : undefined}
                  aria-selected={controlsTab === 'eot'}
                  onClick={() => setControlsTab('eot')}
                >
                  EOT / Turn
                </button>
              )}
            </div>

            {controlsTab === 'helm' && (
              <>
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
              </>
            )}

            {controlsTab === 'weapons' && (canTorpedo || canDepthCharges) && (
              <>
                {canTorpedo && (
                  <TorpedoCalculator
                    ownHeading={vessel.unit.heading}
                    torpedoLoad={vessel.unit.torpedoLoad ?? 0}
                    pending={vessel.unit.orders.fireTorpedo}
                    running={vessel.ownTorpedoes}
                    disabled={!vessel.canSubmitOrders}
                    onSubmit={(fireTorpedo) => void submit({ fireTorpedo })}
                    onClear={() => void submit({ fireTorpedo: null })}
                  />
                )}
                {canDepthCharges && (
                  <DepthChargeControls
                    depthChargeLoad={vessel.unit.depthChargeLoad ?? 0}
                    pending={vessel.unit.orders.dropDepthCharges}
                    tracks={vessel.ownDepthCharges}
                    disabled={!vessel.canSubmitOrders}
                    onSubmit={(dropDepthCharges) => void submit({ dropDepthCharges })}
                    onClear={() => void submit({ dropDepthCharges: null })}
                  />
                )}
                <p className="muted controls-ambient-note">
                  Bridge audio: quiet facility hum loops on this screen; nearby depth-charge
                  detonations play when within ~0.6 nm of own ship (any vessel — not only the
                  dropper). Hydrophone hears the DC sample at longer range when submerged.
                </p>
              </>
            )}

            {controlsTab === 'damage' && (
              <DamageReportPanel
                vesselName={vessel.unit.name}
                vesselType={vessel.unit.type}
                health={vessel.unit.health}
                condition={vessel.unit.condition}
                subsystems={vessel.unit.subsystems}
                damageLog={vessel.ownDamageLog}
              />
            )}

            {controlsTab === 'eot' && (
              <>
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

                <section className="panel stack station-turn-panel">
                  <h2>Turn</h2>
                  <TurnStatus turn={vessel.turn} turnLengthSeconds={vessel.turnLengthSeconds} />
                  {hasPendingOrders(vessel.unit.orders) ? (
                    <div className="orders-of-record" role="status">
                      <span className="status-pill open">Of record</span>
                      <span className="mono readout">
                        {formatPendingOrdersSummary(vessel.unit.orders)}
                      </span>
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
                      {(canTorpedo || canDepthCharges) && (
                        <tr>
                          <th>Ordnance</th>
                          <td className="readout">
                            {canTorpedo ? `TORP ${vessel.unit.torpedoLoad ?? 0}` : ''}
                            {canTorpedo && canDepthCharges ? ' · ' : ''}
                            {canDepthCharges ? `DC ${vessel.unit.depthChargeLoad ?? 0}` : ''}
                          </td>
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
              </>
            )}

          </div>
        )}
      </div>
    </CrtShell>
  );
}
