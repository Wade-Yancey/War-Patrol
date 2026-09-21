import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  EOT_LABELS,
  DEPTH_CHARGE_CONTROLS_AUDIBLE_NM,
  FLEET_SUB_CRUSH_DEPTH_M,
  PERISCOPE_DEPTH_M,
  RADAR_SURFACE_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_MAX_DEPTH_M,
  clampSubmarineDepth,
  conditionLabel,
  effectiveMaxSpeed,
  formatCoarseDepthMeters,
  formatPendingOrdersSummary,
  hasPendingOrders,
  isRadarSurfaced,
  torpedoHitControlsGain,
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
import { useAudioSyncedDamageReport } from '../hooks/useAudioSyncedDamageReport';
import { resolveSunkCause, SunkModal } from '../components/SunkModal';
import {
  DEPTH_CHARGE_AUDIO_SPREAD_SEC,
  DEPTH_CHARGE_CONTROLS_GAIN,
  depthChargeBatchWhenSecById,
  depthChargeControlsGain,
  loadDepthChargeBuffer,
  playDepthChargeSample,
} from '../audio/depthCharge';
import {
  CONTROLS_AMBIENT_GAIN,
  loadControlsAmbientBuffer,
  startControlsAmbientLoop,
} from '../audio/controlsAmbient';
import {
  TORPEDO_HIT_CONTROLS_PEAK_GAIN,
  loadTorpedoHitBuffer,
  playTorpedoHitSample,
} from '../audio/torpedoHit';
import {
  SUBMARINE_CREAK_AMBIENT_DURATION_SEC,
  SUBMARINE_CREAK_AMBIENT_GAIN,
  SUBMARINE_CREAK_DC_DURATION_SEC,
  SUBMARINE_CREAK_DC_GAIN,
  SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC,
  SUBMARINE_CREAK_INTERVAL_SHALLOW_SEC,
  creakIntervalMsForDepth,
  jitterCreakIntervalMs,
  loadSubmarineCreakingBuffer,
  playSubmarineCreakSample,
} from '../audio/submarineCreaking';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

type SensorTab = 'radar' | 'hydrophone' | 'sonar' | 'periscope';
type ControlsTab = 'helm' | 'eot' | 'dive' | 'weapons' | 'damage';

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
  const [periBusy, setPeriBusy] = useState(false);
  /** Own-ship sunk popup — open until Acknowledge; reset if hull returns afloat. */
  const [sunkModalOpen, setSunkModalOpen] = useState(false);
  const sunkModalAckedRef = useRef(false);

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
      clampSubmarineDepth(
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
  /** Hull creaks: submarine Controls only (not destroyer). */
  const onSubCreakBridge =
    onControlsBridge && vessel?.unit.type === 'Submarine';

  const syncedDamage = useAudioSyncedDamageReport(
    vessel?.ownDamageLog,
    vessel?.bridgeDetonations,
    vessel
      ? {
          health: vessel.unit.health,
          condition: vessel.unit.condition,
          subsystems: vessel.unit.subsystems,
        }
      : null,
  );
  const scheduleDamageRevealRef = useRef(syncedDamage.scheduleRevealForDetonation);
  scheduleDamageRevealRef.current = syncedDamage.scheduleRevealForDetonation;

  const playedBridgeBlastRef = useRef<Set<string>>(new Set());
  const pendingBridgeBlastRef = useRef<
    Array<{
      id: string;
      rangeNm: number;
      kind: 'depth_charge' | 'torpedo_hit';
      audioDelaySec?: number;
    }>
  >([]);
  /** Latest sub keel depth for ambient creak scheduling + DC stress burst. */
  const subDepthRef = useRef(0);
  const ambientCreakBusyRef = useRef(false);
  const bridgeAudioRef = useRef<{
    ctx: AudioContext | null;
    buffer: AudioBuffer | null;
    torpedoHitBuffer: AudioBuffer | null;
    creakBuffer: AudioBuffer | null;
    ambientBuffer: AudioBuffer | null;
    ambientSource: AudioBufferSourceNode | null;
    ambientGain: GainNode | null;
  }>({
    ctx: null,
    buffer: null,
    torpedoHitBuffer: null,
    creakBuffer: null,
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
      bridgeAudioRef.current.torpedoHitBuffer = null;
      bridgeAudioRef.current.creakBuffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
    }
    const ctx = bridgeAudioRef.current.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  };

  const ensureCreakBuffer = async (ctx: AudioContext): Promise<AudioBuffer | null> => {
    if (bridgeAudioRef.current.creakBuffer) return bridgeAudioRef.current.creakBuffer;
    try {
      bridgeAudioRef.current.creakBuffer = await loadSubmarineCreakingBuffer(ctx);
      return bridgeAudioRef.current.creakBuffer;
    } catch {
      return null;
    }
  };

  /**
   * Stress creak aligned with a nearby DC one-shot (may be delayed for pattern
   * stagger). One call per charge — not once per pattern. Ambient creaks stay
   * on their own depth-based timer.
   */
  const playDcStressCreak = (
    ctx: AudioContext,
    creak: AudioBuffer,
    whenSec = 0,
  ): void => {
    if (subDepthRef.current <= RADAR_SURFACE_DEPTH_M) return;
    if (ctx.state !== 'running') return;
    playSubmarineCreakSample(ctx, creak, ctx.destination, SUBMARINE_CREAK_DC_GAIN, {
      durationSec: SUBMARINE_CREAK_DC_DURATION_SEC,
      whenSec,
    });
  };

  /** Play queued bridge blasts (close DC + torpedo hits for firer/target). */
  const flushBridgeBlastAudio = async (): Promise<void> => {
    const pending = pendingBridgeBlastRef.current;
    if (!pending.length) return;
    const ctx = await ensureBridgeAudioCtx();
    if (ctx.state !== 'running') return;

    const needsDc = pending.some((e) => e.kind !== 'torpedo_hit');
    const needsHit = pending.some((e) => e.kind === 'torpedo_hit');
    // Load samples independently — a DC fetch failure must not block torpedo hits
    // (and vice versa). Same unlock/queue pattern as the nearby-DC bridge fix.
    if (needsDc && !bridgeAudioRef.current.buffer) {
      try {
        bridgeAudioRef.current.buffer = await loadDepthChargeBuffer(ctx);
      } catch {
        /* keep pending DC; unlock may retry */
      }
    }
    if (needsHit && !bridgeAudioRef.current.torpedoHitBuffer) {
      try {
        bridgeAudioRef.current.torpedoHitBuffer = await loadTorpedoHitBuffer(ctx);
      } catch {
        /* keep pending hits; unlock may retry */
      }
    }
    // Prefetch creak with DC so each staggered blast can schedule a stress burst.
    if (needsDc && onSubCreakBridge) {
      await ensureCreakBuffer(ctx);
    }

    const dcBuffer = bridgeAudioRef.current.buffer;
    const hitBuffer = bridgeAudioRef.current.torpedoHitBuffer;
    const creakBuffer = bridgeAudioRef.current.creakBuffer;
    const still: Array<{
      id: string;
      rangeNm: number;
      kind: 'depth_charge' | 'torpedo_hit';
      audioDelaySec?: number;
    }> = [];

    // Multi-charge patterns arrive as one hear-batch after resolve — stagger
    // one distant-explosion one-shot per charge across ~2 minutes (not stacked).
    const dcBatch = pending
      .filter((e) => e.kind !== 'torpedo_hit' && !playedBridgeBlastRef.current.has(e.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const dcWhenById = depthChargeBatchWhenSecById(dcBatch);

    for (const e of pending) {
      if (playedBridgeBlastRef.current.has(e.id)) continue;
      try {
        if (e.kind === 'torpedo_hit') {
          if (!hitBuffer) {
            still.push(e);
            continue;
          }
          // Floor so distant firer/target still hear a clear blast, not a tick.
          const gain =
            TORPEDO_HIT_CONTROLS_PEAK_GAIN *
            Math.max(0.35, torpedoHitControlsGain(e.rangeNm));
          // Arrival offset into the resolved turn — not at the resolve click.
          const whenSec = Math.max(0, e.audioDelaySec ?? 0);
          playTorpedoHitSample(ctx, hitBuffer, ctx.destination, gain, { whenSec });
          scheduleDamageRevealRef.current(e.id, whenSec);
        } else {
          if (!dcBuffer) {
            still.push(e);
            continue;
          }
          const whenSec = dcWhenById.get(e.id) ?? 0;
          // Per-charge range attenuation (closer = louder); silent past hear radius.
          const peak =
            DEPTH_CHARGE_CONTROLS_GAIN * depthChargeControlsGain(e.rangeNm);
          if (peak < 0.001) {
            playedBridgeBlastRef.current.add(e.id);
            scheduleDamageRevealRef.current(e.id, whenSec);
            continue;
          }
          playDepthChargeSample(ctx, dcBuffer, ctx.destination, peak, { whenSec });
          // Sub Controls: hull creak with *each* nearby charge (same schedule).
          if (onSubCreakBridge && creakBuffer) {
            playDcStressCreak(ctx, creakBuffer, whenSec);
          }
          // Own-ship Damage report reveals with this charge's blast, not at resolve.
          scheduleDamageRevealRef.current(e.id, whenSec);
        }
        playedBridgeBlastRef.current.add(e.id);
      } catch {
        still.push(e);
      }
    }
    pendingBridgeBlastRef.current = still;
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
        await flushBridgeBlastAudio();
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
      void flushBridgeBlastAudio();
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
      bridgeAudioRef.current.torpedoHitBuffer = null;
      bridgeAudioRef.current.creakBuffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
      // Closed ctx → allow replay after remount (React Strict Mode / leave+rejoin).
      playedBridgeBlastRef.current.clear();
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [onControlsBridge]);

  const surfaced = vessel ? isRadarSurfaced(vessel.unit.position) : true;
  const depthM = vessel?.unit.position.depth ?? 0;
  subDepthRef.current = depthM;
  const atPeriscopeDepth = depthM <= PERISCOPE_DEPTH_M;
  /** Ambient creak loop only while keel is below the radar surface band. */
  const submergedForCreak = onSubCreakBridge && depthM > RADAR_SURFACE_DEPTH_M;

  // Submarine Controls: occasional hull creaks while submerged; denser with depth.
  useEffect(() => {
    if (!submergedForCreak) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = () => {
      clearTimer();
      if (cancelled) return;
      const meanMs = creakIntervalMsForDepth(subDepthRef.current);
      if (!Number.isFinite(meanMs)) return;
      const wait = jitterCreakIntervalMs(meanMs);
      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          // Skip if still surfaced or a prior ambient creak is ringing.
          if (subDepthRef.current <= RADAR_SURFACE_DEPTH_M) {
            return;
          }
          if (ambientCreakBusyRef.current) {
            timer = setTimeout(() => {
              void scheduleNext();
            }, 800);
            return;
          }
          try {
            const ctx = await ensureBridgeAudioCtx();
            if (cancelled || ctx.state !== 'running') {
              scheduleNext();
              return;
            }
            const creak = await ensureCreakBuffer(ctx);
            if (cancelled || !creak) {
              scheduleNext();
              return;
            }
            if (ambientCreakBusyRef.current) {
              timer = setTimeout(() => {
                void scheduleNext();
              }, 800);
              return;
            }
            ambientCreakBusyRef.current = true;
            const source = playSubmarineCreakSample(
              ctx,
              creak,
              ctx.destination,
              SUBMARINE_CREAK_AMBIENT_GAIN,
              { durationSec: SUBMARINE_CREAK_AMBIENT_DURATION_SEC },
            );
            if (source) {
              source.onended = () => {
                ambientCreakBusyRef.current = false;
              };
              // Safety: clear busy if onended never fires (ctx closed).
              window.setTimeout(() => {
                ambientCreakBusyRef.current = false;
              }, (SUBMARINE_CREAK_AMBIENT_DURATION_SEC + 0.5) * 1000);
            } else {
              ambientCreakBusyRef.current = false;
            }
          } catch {
            ambientCreakBusyRef.current = false;
          }
          scheduleNext();
        })();
      }, wait);
    };

    const unlock = () => {
      scheduleNext();
    };

    // Kick after gesture / ambient unlock so Autoplay policy is satisfied.
    scheduleNext();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    return () => {
      cancelled = true;
      clearTimer();
      ambientCreakBusyRef.current = false;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [submergedForCreak]);

  // Controls bridge: queue + play DC / torpedo-hit blasts (attenuated by range).
  useEffect(() => {
    if (!onControlsBridge || !vessel) return;
    const events = vessel.bridgeDetonations ?? [];
    const live = new Set(events.map((e) => e.id));
    for (const id of [...playedBridgeBlastRef.current]) {
      if (!live.has(id)) playedBridgeBlastRef.current.delete(id);
    }
    pendingBridgeBlastRef.current = events
      .filter((e) => !playedBridgeBlastRef.current.has(e.id))
      .map((e) => ({
        id: e.id,
        rangeNm: e.rangeNm,
        kind: e.kind ?? 'depth_charge',
        audioDelaySec: e.audioDelaySec,
      }));
    if (!pendingBridgeBlastRef.current.length) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await flushBridgeBlastAudio();
    })();
    return () => {
      cancelled = true;
    };
  }, [onControlsBridge, vessel, vessel?.bridgeDetonations, vessel?.stateVersion]);

  // Own-ship sunk popup on Controls + Sensors (not umpire). Light delay when a
  // Controls bridge blast cue is present so the killing one-shot can start first.
  const ownShipSunk = vessel?.unit.condition === 'sunk';
  const sunkCause = useMemo(
    () => resolveSunkCause(vessel?.ownDamageLog),
    [vessel?.ownDamageLog],
  );
  useEffect(() => {
    if (!vessel || !ownShipSunk) {
      sunkModalAckedRef.current = false;
      setSunkModalOpen(false);
      return;
    }
    if (sunkModalAckedRef.current) return;

    const waitForBlast =
      onControlsBridge &&
      sunkCause !== 'implosion' &&
      (vessel.bridgeDetonations?.length ?? 0) > 0;
    // First DC/torpedo one-shot is scheduled at whenSec=0; short beat so audio leads.
    const delayMs = waitForBlast ? 650 : 0;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled && !sunkModalAckedRef.current) setSunkModalOpen(true);
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Deliberately omit full `vessel` — SSE ticks must not restart the delay.
  }, [ownShipSunk, vessel?.unit.id, onControlsBridge, sunkCause]);

  // Sub Sensors: pick a sensible default tab from depth; follow depth-band changes.
  // Do not depend on the whole vessel object — mast raise/lower updates must
  // not re-run this and kick the operator off Periscope.
  const hasVessel = Boolean(vessel);
  useEffect(() => {
    if (!hasVessel || !isSensors) return;
    if (canHydrophone && canRadar) {
      const preferred: SensorTab = surfaced
        ? 'radar'
        : canPeriscope && atPeriscopeDepth
          ? 'periscope'
          : 'hydrophone';
      setSensorTab((prev) => {
        if (prev === 'radar' || prev === 'hydrophone' || prev === 'periscope') {
          // Hydrophone is unusable on the surface → leave it. Periscope stays valid
          // at/above radar surface depth, so never force Radar while on Periscope.
          if (surfaced && prev === 'hydrophone') return 'radar';
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
    hasVessel,
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

  const togglePeriscope = async (raised: boolean) => {
    if (!token) return;
    setActionError(null);
    setPeriBusy(true);
    try {
      await api.setPeriscope(gameId, token, raised);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Periscope toggle failed');
    } finally {
      setPeriBusy(false);
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

        {vessel && sunkModalOpen && (
          <SunkModal
            vesselName={vessel.unit.name}
            vesselType={vessel.unit.type}
            cause={sunkCause}
            onAcknowledge={() => {
              sunkModalAckedRef.current = true;
              setSunkModalOpen(false);
            }}
          />
        )}

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
                    {opticsVariant === 'lookout'
                      ? vessel.periscopeOperational
                        ? ` Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · bridge lookout.`
                        : vessel.periscopeUnavailableReason === 'no_sensor'
                          ? ' No lookout set installed.'
                          : vessel.periscopeUnavailableReason === 'sunk'
                            ? ' Set offline — unit sunk/destroyed.'
                            : ''
                      : vessel.periscopeOperational
                        ? ` Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · mast UP · depth ≤ ${PERISCOPE_DEPTH_M} m.`
                        : vessel.periscopeUnavailableReason === 'scope_down'
                          ? ' Mast DOWN — optically blind. Raise to see.'
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
                {opticsVariant === 'periscope' && (
                  <div className="stack" style={{ gap: '0.5rem' }}>
                    <div className="sonar-toggle-row">
                      <button
                        type="button"
                        className={vessel.unit.periscopeRaised ? 'primary' : undefined}
                        disabled={
                          periBusy ||
                          vessel.periscopeUnavailableReason === 'no_sensor' ||
                          vessel.periscopeUnavailableReason === 'sunk' ||
                          vessel.periscopeUnavailableReason === 'sensors_disabled' ||
                          (!vessel.unit.periscopeRaised &&
                            (vessel.periscopeUnavailableReason === 'too_deep' ||
                              vessel.unit.position.depth > PERISCOPE_DEPTH_M))
                        }
                        aria-pressed={Boolean(vessel.unit.periscopeRaised)}
                        onClick={() => void togglePeriscope(!vessel.unit.periscopeRaised)}
                      >
                        {vessel.unit.periscopeRaised ? 'Periscope UP' : 'Periscope DOWN'}
                      </button>
                      <span className="mono muted">
                        {vessel.unit.periscopeRaised
                          ? `RAISED · stamp ${vessel.unit.plotStampTurns ?? 0}`
                          : 'LOWERED · blind · not spottable'}
                      </span>
                    </div>
                  </div>
                )}
                {vessel.periscopeOperational === false &&
                vessel.periscopeUnavailableReason !== 'scope_down' ? (
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
                      contacts={
                        vessel.periscopeUnavailableReason === 'scope_down'
                          ? []
                          : (vessel.periscopeContacts ?? [])
                      }
                      maxRangeNm={vessel.periscopeMaxRangeNm ?? 6}
                      ownHeading={vessel.unit.heading}
                      variant={opticsVariant}
                      blind={vessel.periscopeUnavailableReason === 'scope_down'}
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
                    {(() => {
                      const events = vessel.bridgeDetonations!;
                      const hits = events.filter((d) => d.kind === 'torpedo_hit').length;
                      const dcs = events.filter((d) => d.kind !== 'torpedo_hit').length;
                      const parts: string[] = [];
                      if (hits > 0) {
                        parts.push(
                          `TORPEDO HIT ×${hits} (attenuated · firer/target)`,
                        );
                      }
                      if (dcs > 0) {
                        parts.push(
                          `DEPTH CHARGE ×${dcs} within ~${Math.max(
                            ...events.filter((d) => d.kind !== 'torpedo_hit').map((d) => d.rangeNm),
                          ).toFixed(2)} nm`,
                        );
                      }
                      return parts.join(' · ') || 'Weapon blast';
                    })()}
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
                      {formatCoarseDepthMeters(vessel.unit.position.depth)}
                      {Math.round(vessel.unit.orderedDepth ?? vessel.unit.position.depth) !==
                        Math.round(vessel.unit.position.depth) && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: '0.75em' }}>
                          → {formatCoarseDepthMeters(vessel.unit.orderedDepth ?? 0)}
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
                Helm
              </button>
              {canEot && (
                <button
                  type="button"
                  role="tab"
                  className={controlsTab === 'eot' ? 'primary' : undefined}
                  aria-selected={controlsTab === 'eot'}
                  onClick={() => setControlsTab('eot')}
                >
                  EOT
                </button>
              )}
              {canHelm && vessel.unit.type === 'Submarine' && (
                <button
                  type="button"
                  role="tab"
                  className={controlsTab === 'dive' ? 'primary' : undefined}
                  aria-selected={controlsTab === 'dive'}
                  onClick={() => setControlsTab('dive')}
                >
                  Dive Plane
                </button>
              )}
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
            </div>

            {controlsTab === 'helm' && (
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
            )}

            {controlsTab === 'dive' && canHelm && vessel.unit.type === 'Submarine' && (
              <section className="panel stack controls-dive-panel">
                <div className="controls-section-head">
                  <h2>Dive plane</h2>
                  <p className="muted controls-section-blurb">
                    Coarse {SUBMARINE_DEPTH_ORDER_STEP_M} m dial — presets and band marks (patrol /
                    test / crush). You may order past crush; that risks implosion.
                  </p>
                </div>
                <DiveControls
                  depth={vessel.unit.position.depth}
                  orderedDepth={vessel.unit.orderedDepth ?? vessel.unit.position.depth}
                  draftDepth={depth}
                  onDraftDepthChange={(d) => setDepth(clampSubmarineDepth(d))}
                  maxDepthM={SUBMARINE_MAX_DEPTH_M}
                  orderStepM={SUBMARINE_DEPTH_ORDER_STEP_M}
                  disabled={!vessel.canSubmitOrders}
                  onSubmit={(d) => void submit({ depth: clampSubmarineDepth(d) })}
                />
              </section>
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
                  detonations play when within ~{DEPTH_CHARGE_CONTROLS_AUDIBLE_NM} nm of own ship
                  (any vessel — not only the dropper) — close blasts are loud, then fall off
                  sharply with range toward silence at the hear-radius edge.
                  Multi-charge patterns play one distant-explosion sample per charge, spaced
                  evenly across ~{DEPTH_CHARGE_AUDIO_SPREAD_SEC / 60} minutes (not stacked),
                  each at its own range volume. Own-ship Damage report lines (and hull readout
                  on that tab) appear with each blast cue — not all at once on resolve.
                  Torpedo hits play the explosion for both firer and target Controls when the
                  fish reaches the target (offset into the resolved turn), attenuated by range,
                  and the Damage report for that hit waits for the same cue. Submarine Controls also
                  hear occasional hull creaks while submerged (depth &gt; {RADAR_SURFACE_DEPTH_M}{' '}
                  m), denser toward test depth and <em>super frequent</em> near crush (~
                  {SUBMARINE_CREAK_INTERVAL_SHALLOW_SEC} s mean near the surface band down to ~
                  {SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC} s at {FLEET_SUB_CRUSH_DEPTH_M} m crush),
                  plus a stress creak timed with <em>each</em> nearby depth-charge blast.
                  Hydrophone hears the DC sample at longer range when submerged.
                </p>
              </>
            )}

            {controlsTab === 'damage' && (
              <DamageReportPanel
                vesselName={vessel.unit.name}
                vesselType={vessel.unit.type}
                health={syncedDamage.health}
                condition={syncedDamage.condition}
                subsystems={syncedDamage.subsystems}
                damageLog={syncedDamage.damageLog}
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
                          <td className="readout">{formatCoarseDepthMeters(vessel.unit.position.depth)}</td>
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
