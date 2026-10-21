import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ACTIVE_SONAR_PING_INTERVAL_SEC,
  EOT_LABELS,
  PERISCOPE_DEPTH_M,
  RADAR_SURFACE_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_MAX_DEPTH_M,
  activeSonarControlsPeakGain,
  clampSubmarineDepth,
  conditionLabel,
  controlsInstrumentTabsForHull,
  effectiveMaxSpeed,
  expectedMoveThisTurn,
  formatCoarseDepthMeters,
  formatPendingOrdersSummary,
  hasPendingOrders,
  isHydrophoneReloadCueLive,
  isRadarSurfaced,
  normalizeHeading,
  torpedoHitControlsGain,
  type ControlsInstrumentTab,
  type EotSetting,
  type OpticsSighting,
  type PeriscopeContact,
  type UnitOrders,
  type VesselView,
} from '@war-patrol/shared';
import { api } from '../api/client';
import { clearAuthToken, getAuthToken, setAuthToken } from '../api/authStorage';
import { playEngineOrderBell } from '../audio/engineOrderBell';
import { isWpDebugEnabled, wpDebug } from '../debug/wpDebug';
import { useGameStream, type ViewRefreshReason } from '../hooks/useGameStream';
import {
  buildContinueStandingOrdersPatch,
  mergeOrdersOptimistic,
  ordersContentEqual,
  type StationOrdersPatch,
} from '../ordersOptimistic';
import { TurnStatus } from '../components/TurnStatus';
import { CrtShell } from '../components/CrtShell';
import { EotTelegraph } from '../components/EotTelegraph';
import { HelmCompass } from '../components/HelmCompass';
import { CrtTrainControl } from '../components/CrtTrainControl';
import { DiveControls } from '../components/DiveControls';
import {
  HydrophoneScope,
  HYDROPHONE_MASTER_GAIN_DEFAULT,
  HYDROPHONE_MASTER_GAIN_DESTROYER,
} from '../components/HydrophoneScope';
import { PeriscopeScope } from '../components/PeriscopeScope';
import { RadarScope } from '../components/RadarScope';
import { ActiveSonarScope } from '../components/ActiveSonarScope';
import { TorpedoCalculator } from '../components/TorpedoCalculator';
import { DepthChargeControls } from '../components/DepthChargeControls';
import { DeckGunControls } from '../components/DeckGunControls';
import { CountermeasuresControls } from '../components/CountermeasuresControls';
import { DamageReportPanel } from '../components/DamageReportPanel';
import { MoveDistanceReadout } from '../components/MoveDistanceReadout';
import { useAudioSyncedDamageReport } from '../hooks/useAudioSyncedDamageReport';
import { usePresentationSensorStations } from '../hooks/usePresentationSensorStations';
import { useTweenedDepth } from '../hooks/useTweenedDepth';
import { resolveSunkCause, SunkModal } from '../components/SunkModal';
import { StationInstrumentTitle } from '../components/StationInfoButton';
import { stationGuideIdFor } from '../stationGuides';
import {
  depthChargeBatchWhenSecById,
  depthChargeControlsPeakGain,
  loadDepthChargeBuffer,
  playDepthChargeSample,
} from '../audio/depthCharge';
import {
  CONTROLS_AMBIENT_GAIN,
  loadControlsAmbientBuffer,
  startControlsAmbientLoop,
} from '../audio/controlsAmbient';
import {
  crossfadeAmbientLoop,
  loadSubAmbientBuffer,
  rampAmbientLoopGain,
  stopAmbientLoopVoice,
  subAmbientBandForDepth,
  subAmbientCrossfadeSec,
  subAmbientGainForDepth,
  type SubAmbientBand,
} from '../audio/subControlsAmbient';
import {
  loadSonarPingBuffer,
  playSonarPingSample,
  SONAR_PING_CONTROLS_OWN_GAIN,
} from '../audio/sonarPing';
import {
  EXPLOSION_CONTROLS_PEAK_GAIN,
  TORPEDO_HIT_CONTROLS_PEAK_GAIN,
  loadExplosionBuffer,
  loadTorpedoHitBuffer,
  playTorpedoHitSample,
  torpedoHitBatchWhenSecById,
} from '../audio/torpedoHit';
import {
  DECK_GUN_FIRE_CONTROLS_PEAK_GAIN,
  deckGunFireBatchWhenSecById,
  loadDeckGunFireBuffer,
  playDeckGunFireSample,
} from '../audio/deckGunFire';
import {
  TORPEDO_FIRE_CONTROLS_PEAK_GAIN,
  loadTorpedoFireBuffer,
  playTorpedoFireSample,
  torpedoFireBatchWhenSecById,
} from '../audio/torpedoFire';
import {
  SUBMARINE_CREAK_DC_DURATION_SEC,
  SUBMARINE_CREAK_DC_GAIN,
  loadSubmarineCreakingBuffer,
  playSubmarineCreakSample,
} from '../audio/submarineCreaking';
import {
  TORPEDO_RELOAD_KNOCK_CONTROLS_PEAK_GAIN,
  loadTorpedoReloadKnockBuffer,
  playTorpedoReloadKnockCouplet,
} from '../audio/torpedoReloadKnock';
import {
  playSubDepthChange,
  shouldPlaySubDepthChangeSfx,
  type SubDepthChangeSfxSnapshot,
} from '../audio/subDepthChange';
import {
  EMERGENCY_BLOW_VENTING_PEAK_GAIN,
  SUB_DEPTH_CHANGE_EMERGENCY_BLOW_GAIN,
  loadEmergencyBlowVentingBuffer,
  playEmergencyBlowVentingSample,
} from '../audio/emergencyBlowVenting';

function tokenKey(gameId: string, accessToken: string, stationId: string) {
  return `wp-token:${gameId}:${accessToken}:${stationId}`;
}

/** Course nudge step for the helm ◀ / ▶ train buttons (degrees). */
const COURSE_NUDGE_DEG = 1;

/** Stable empty optics lists — avoid new `[]` each render breaking `PeriscopeScope` memo. */
const EMPTY_PERISCOPE_CONTACTS: PeriscopeContact[] = [];
const EMPTY_OPTICS_SIGHTINGS: OpticsSighting[] = [];

/** Coalesce rapid mast toggles so remote POSTs are not spammed per click. */
const PERISCOPE_WRITE_DEBOUNCE_MS = 80;

/**
 * Bounded GET /view polls after a peri raise when FoW is still pending.
 * Snapshot-only — does not reopen the live stream or trip the stale watchdog.
 * (#248 ping-before-state catch-up was reverted for tunnel RECONNECTING thrash.)
 */
const PERI_FOW_VIEW_REFRESH_DELAYS_MS = [1_500, 4_000] as const;
/** Min gap between Sensors Lookout/Periscope tab focus → /view refreshes. */
const OPTICS_TAB_VIEW_REFRESH_COOLDOWN_MS = 6_000;

type SensorTab = 'radar' | 'hydrophone' | 'sonar' | 'periscope';
type ControlsTab = ControlsInstrumentTab;

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
  /**
   * Local-first active-sonar latch — paints immediately; cleared when SSE matches
   * (or on write failure). Same remote-RTT pattern as mast UP/DOWN.
   */
  const [sonarOptimisticEnabled, setSonarOptimisticEnabled] = useState<boolean | null>(
    null,
  );
  const [periBusy, setPeriBusy] = useState(false);
  /**
   * Local-first mast overlay — UI follows this immediately; network write is
   * debounced. Cleared once the SSE/view mast flag matches (or on write failure).
   */
  const [periOptimisticRaised, setPeriOptimisticRaised] = useState<boolean | null>(
    null,
  );
  /**
   * Optimistic of-record orders: paint on click, refine from POST body, clear
   * when SSE catches up. Avoids waiting a full tunnel SSE cycle for ORD chrome.
   */
  const [ordersOverlay, setOrdersOverlay] = useState<UnitOrders | null>(null);
  /** In-flight order POSTs (latest-wins; not a hard lock against other fields). */
  const [orderWriteInFlight, setOrderWriteInFlight] = useState(0);
  const [weaponReloadBusy, setWeaponReloadBusy] = useState(false);
  /** Local-first reload latch until SSE awaitingReload matches. */
  const [reloadOptimistic, setReloadOptimistic] = useState<{
    torpedoForward?: boolean;
    torpedoAft?: boolean;
    depthCharges?: boolean;
    deckGun?: boolean;
  }>({});
  /** Own-ship sunk popup — open until Acknowledge; reset if hull returns afloat. */
  const [sunkModalOpen, setSunkModalOpen] = useState(false);
  const sunkModalAckedRef = useRef(false);
  const periWriteTimerRef = useRef<number | null>(null);
  const periWriteGenRef = useRef(0);
  const periDesiredRaisedRef = useRef<boolean | null>(null);
  /**
   * Raise-window FoW readiness — optimistic mast UP must not flash “no contacts”
   * while the first authoritative picture is still in flight over the tunnel.
   * `periRaiseGen` bumps on each raise; `periFowReadyGen` catches up when the
   * streamed view confirms mast UP (SSE or GET /view).
   */
  const [periRaiseGen, setPeriRaiseGen] = useState(0);
  /** Starts equal to `periRaiseGen` so a cold load with mast already UP is not “Raising…”. */
  const [periFowReadyGen, setPeriFowReadyGen] = useState(0);
  /** Turn-scoped last-good peri FoW (contacts + sightings) for re-raise / catch-up. */
  const [periTurnFowCache, setPeriTurnFowCache] = useState<{
    turn: number;
    contacts: PeriscopeContact[];
    sightings: OpticsSighting[];
  } | null>(null);
  const opticsTabFocusedRef = useRef(false);
  const opticsTabRefreshAtRef = useRef(0);
  const periRaiseGenRef = useRef(0);
  const streamRefreshRef = useRef<(reason?: ViewRefreshReason) => void>(() => undefined);
  const orderWriteGenRef = useRef(0);
  const ordersOverlayRef = useRef<UnitOrders | null>(null);
  const turnNumberRef = useRef<number | null>(null);
  const sonarWriteGenRef = useRef(0);

  const { view, stateVersion, connected, error, refresh } = useGameStream({
    gameId,
    token,
    enabled: Boolean(token),
    onAuthInvalid: () => {
      clearAuthToken(tokenKey(gameId, accessToken, stationId));
      setToken(null);
      setAuthError('Session expired — enter the vessel password again');
    },
  });
  streamRefreshRef.current = refresh;
  periRaiseGenRef.current = periRaiseGen;

  const vessel = view?.role === 'vessel' ? (view as VesselView) : null;
  /** Pending of-record for chrome: overlay first, else streamed unit.orders. */
  const displayOrders: UnitOrders = ordersOverlay ?? vessel?.unit.orders ?? {};
  const orderWritePending = orderWriteInFlight > 0;
  const faction = vessel?.unit.faction;

  useEffect(() => {
    ordersOverlayRef.current = ordersOverlay;
  }, [ordersOverlay]);

  // Drop order overlay once SSE of-record matches (or after resolve clears orders).
  useEffect(() => {
    if (!vessel || !ordersOverlay) return;
    if (ordersContentEqual(vessel.unit.orders, ordersOverlay)) {
      setOrdersOverlay(null);
      return;
    }
    // Turn resolve / reopen emptied stream orders while we were not writing.
    if (
      orderWriteInFlight === 0 &&
      !hasPendingOrders(vessel.unit.orders) &&
      hasPendingOrders(ordersOverlay) &&
      !vessel.canSubmitOrders
    ) {
      setOrdersOverlay(null);
    }
  }, [vessel, ordersOverlay, orderWriteInFlight]);

  // New turn number → drop stale optimistic of-record (resolve applied).
  useEffect(() => {
    const n = vessel?.turn.number ?? null;
    if (n == null) return;
    if (turnNumberRef.current != null && turnNumberRef.current !== n) {
      setOrdersOverlay(null);
      setOrderWriteInFlight(0);
      orderWriteGenRef.current += 1;
      setReloadOptimistic({});
      setPeriTurnFowCache(null);
      setPeriFowReadyGen(-1);
    }
    turnNumberRef.current = n;
  }, [vessel?.turn.number]);
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
  /**
   * MOVE readout EOT: Controls uses local telegraph (live while planning);
   * Sensors uses standing/pending order that will apply on next resolve.
   */
  const moveEot: EotSetting = isControls
    ? eot
    : (vessel?.unit.orders.eot ?? vessel?.unit.eot ?? 'stop');
  const moveOrderedDepth =
    isControls && vessel?.unit.type === 'Submarine'
      ? depth
      : (vessel?.unit.orders.depth ??
        vessel?.unit.orderedDepth ??
        vessel?.unit.position.depth ??
        0);
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
  const canDeckGun =
    canWeapons &&
    (vessel?.unit.class === 'Destroyer' ||
      vessel?.unit.class === 'Fleet Submarine' ||
      vessel?.unit.type === 'Submarine');
  const canCountermeasures =
    canWeapons &&
    (vessel?.unit.class === 'Fleet Submarine' || vessel?.unit.type === 'Submarine');
  const controlsTabs = useMemo(
    () => controlsInstrumentTabsForHull(vessel?.unit.class ?? vessel?.unit.type),
    [vessel?.unit.class, vessel?.unit.type],
  );
  /** Surface ships use lookout (always available); subs use depth-gated periscope. */
  const opticsVariant: 'periscope' | 'lookout' =
    vessel?.unit.type === 'Submarine' ? 'periscope' : 'lookout';
  const opticsTabLabel = opticsVariant === 'lookout' ? 'Lookout' : 'Periscope';
  /** Playable hull for station-guide blurbs (DD / Fleet Sub). */
  const hullGuideClass =
    vessel?.unit.class ??
    (vessel?.unit.type === 'Submarine' ? 'Fleet Submarine' : undefined);
  const guideHelm = stationGuideIdFor(hullGuideClass, 'helm');
  const guideEot = stationGuideIdFor(hullGuideClass, 'eot');
  const guideDive = stationGuideIdFor(hullGuideClass, 'dive');
  const guideRadar = stationGuideIdFor(hullGuideClass, 'radar');
  const guideOptics = stationGuideIdFor(
    hullGuideClass,
    opticsVariant === 'lookout' ? 'lookout' : 'periscope',
  );
  const guideHydrophone = stationGuideIdFor(hullGuideClass, 'hydrophone');
  const guideActiveSonar = stationGuideIdFor(hullGuideClass, 'active_sonar');
  const sensorFocus =
    isSensors && (canRadar || canHydrophone || canActiveSonar || canPeriscope);

  const onControlsBridge = Boolean(vessel) && isControls && !isSensors;
  /** Hull creaks: submarine Controls only (not destroyer). */
  const onSubCreakBridge =
    onControlsBridge && vessel?.unit.type === 'Submarine';

  /** Shared Dive needle clock — also gates crush-implosion sunk reveal. */
  const displayedKeelDepthM = useTweenedDepth(vessel?.unit.position.depth);
  const syncedDamage = useAudioSyncedDamageReport(
    vessel?.ownDamageLog,
    vessel?.bridgeDetonations,
    vessel
      ? {
          health: vessel.unit.health,
          condition: vessel.unit.condition,
          subsystems: vessel.unit.subsystems,
          depth: vessel.unit.position.depth,
        }
      : null,
    vessel?.unit.type === 'Submarine' ? displayedKeelDepthM : undefined,
  );
  /** Presentation subsystems/condition for station chrome (matches blast reveal). */
  const presentationSubs = syncedDamage.subsystems;
  const presentationSensors = usePresentationSensorStations(
    vessel,
    vessel
      ? {
          condition: syncedDamage.condition,
          subsystems: presentationSubs,
          type: vessel.unit.type,
        }
      : null,
  );
  const expectedMove = useMemo(() => {
    if (!vessel) return null;
    return expectedMoveThisTurn({
      type: vessel.unit.type,
      class: vessel.unit.class,
      maxSpeed: vessel.unit.maxSpeed,
      speed: vessel.unit.speed,
      depth: vessel.unit.position.depth,
      orderedDepth: moveOrderedDepth,
      eot: moveEot,
      turnLengthSeconds: vessel.turnLengthSeconds,
      propulsion: presentationSubs.propulsion,
      condition: syncedDamage.condition,
    });
  }, [vessel, moveEot, moveOrderedDepth, presentationSubs.propulsion, syncedDamage.condition]);
  /** Mast chrome follows optimistic overlay when set (remote RTT must not gate the button). */
  const opticsMastRaised =
    periOptimisticRaised !== null
      ? periOptimisticRaised
      : presentationSensors.periscopeRaised;
  /** Active-sonar latch chrome — optimistic first so remote taps are not dead. */
  const sonarLatchEnabled =
    sonarOptimisticEnabled !== null
      ? sonarOptimisticEnabled
      : presentationSensors.activeSonarEnabled;
  /**
   * Scope-down blind: optimistic lower blinds immediately; optimistic raise
   * unblinds chrome immediately (contacts fill when FoW arrives via SSE).
   */
  const opticsScopeDown =
    opticsVariant === 'periscope' && periOptimisticRaised !== null
      ? !periOptimisticRaised
      : presentationSensors.periscopeUnavailableReason === 'scope_down';
  const opticsHardUnavailable =
    presentationSensors.periscopeOperational === false &&
    presentationSensors.periscopeUnavailableReason !== 'scope_down' &&
    periOptimisticRaised !== true;
  // Do not defer contacts/sightings — DD lookout must paint a remote peri feather
  // (and wake sightings) as soon as the SSE/view catch-up arrives. Contact pick /
  // compass stay local in PeriscopeScope; only streamed HDG is deferred below.
  // (#246 urgent SSE + heartbeat ping version catch-up; no ping-before-state.)
  const turnNumber = vessel?.turn.number ?? null;
  const periTurnCache =
    periTurnFowCache && turnNumber != null && periTurnFowCache.turn === turnNumber
      ? periTurnFowCache
      : null;
  const periFowPending =
    opticsVariant === 'periscope' &&
    opticsMastRaised &&
    !opticsScopeDown &&
    periFowReadyGen !== periRaiseGen;
  const opticsRaising = periFowPending && !periTurnCache;
  const opticsContacts = opticsScopeDown
    ? EMPTY_PERISCOPE_CONTACTS
    : periFowPending
      ? (periTurnCache?.contacts ?? EMPTY_PERISCOPE_CONTACTS)
      : presentationSensors.periscopeContacts;
  const opticsSightings = opticsScopeDown
    ? EMPTY_OPTICS_SIGHTINGS
    : periFowPending
      ? (periTurnCache?.sightings ?? EMPTY_OPTICS_SIGHTINGS)
      : presentationSensors.opticsSightings;
  const opticsOwnHeading = useDeferredValue(vessel?.unit.heading ?? 0);

  // Diagnostics-only: peri / lookout FoW readiness vs streamed mast (gated).
  useEffect(() => {
    if (!isWpDebugEnabled()) return;
    if (opticsVariant !== 'periscope' && opticsVariant !== 'lookout') return;
    wpDebug('periFow', {
      opticsVariant,
      turnId: turnNumber,
      stateVersion,
      connected,
      periRaiseGen,
      periFowReadyGen,
      periFowPending,
      opticsRaising,
      opticsScopeDown,
      optimisticMast: periOptimisticRaised,
      serverMast: presentationSensors.periscopeRaised,
      paintedMast: opticsMastRaised,
      contactCount: opticsContacts.length,
      sightingCount: opticsSightings.length,
      streamedContactCount: presentationSensors.periscopeContacts.length,
      turnCache: periTurnCache
        ? {
            turn: periTurnCache.turn,
            contacts: periTurnCache.contacts.length,
            sightings: periTurnCache.sightings.length,
          }
        : null,
      emptyWhilePending: periFowPending && opticsContacts.length === 0,
    });
  }, [
    opticsVariant,
    turnNumber,
    stateVersion,
    connected,
    periRaiseGen,
    periFowReadyGen,
    periFowPending,
    opticsRaising,
    opticsScopeDown,
    periOptimisticRaised,
    presentationSensors.periscopeRaised,
    opticsMastRaised,
    opticsContacts.length,
    opticsSightings.length,
    presentationSensors.periscopeContacts.length,
    periTurnCache,
  ]);
  const scheduleDamageRevealRef = useRef(syncedDamage.scheduleRevealForDetonation);
  scheduleDamageRevealRef.current = syncedDamage.scheduleRevealForDetonation;

  const playedBridgeBlastRef = useRef<Set<string>>(new Set());
  const pendingBridgeBlastRef = useRef<
    Array<{
      id: string;
      rangeNm: number;
      kind:
        | 'depth_charge'
        | 'torpedo_hit'
        | 'torpedo_fire'
        | 'aircraft_bomb'
        | 'deck_gun_fire'
        | 'deck_gun_hit';
      audioDelaySec?: number;
    }>
  >([]);
  /**
   * Latest Dive DEPTH needle depth (tweened) for ambient band selection.
   * Band changes wait until the needle crosses the threshold — not resolve-jump keel.
   */
  const subDepthRef = useRef(0);
  /**
   * Seed for depth-change SFX: play when turn advances, keel moved, and the
   * ordered depth set-point is new (not every submerged transit resolve).
   * Null until first sub-Controls observation (initial load stays silent).
   */
  const depthChangeSfxRef = useRef<SubDepthChangeSfxSnapshot | null>(null);
  /**
   * Armed when Dive Controls applies the Emergency Blow preset (ordered 0 m).
   * Cleared on any other depth submit, when ordered depth leaves 0 *after*
   * the blow order was observed, or when the keel reaches the surface band.
   */
  const pendingEmergencyBlowRef = useRef(false);
  /**
   * Latches once `orderedDepth === 0` while pending. Prevents vessel-stream
   * refreshes (still carrying the prior non-zero ordered depth) from clearing
   * the arm before the Emergency Blow submit is acknowledged.
   */
  const emergencyBlowOrderSeenRef = useRef(false);
  /** Own-ship reload knock burst: once per acoustic turn while cue is live. */
  const playedOwnReloadKnockTurnRef = useRef<number | null>(null);
  const bridgeAudioRef = useRef<{
    ctx: AudioContext | null;
    buffer: AudioBuffer | null;
    torpedoHitBuffer: AudioBuffer | null;
    /** Deck-gun hit / aircraft-bomb splash (`explosion.wav`). */
    explosionBuffer: AudioBuffer | null;
    deckGunFireBuffer: AudioBuffer | null;
    torpedoFireBuffer: AudioBuffer | null;
    reloadKnockBuffer: AudioBuffer | null;
    creakBuffer: AudioBuffer | null;
    ventingBuffer: AudioBuffer | null;
    /** Destroyer facility-hum buffer. */
    ambientBuffer: AudioBuffer | null;
    /** Sub depth-banded ambient buffers (lazy). */
    subAmbientBuffers: Partial<Record<SubAmbientBand, AudioBuffer>>;
    /** Active sub ambient band (null until first loop starts). */
    subAmbientBand: SubAmbientBand | null;
    sonarPingBuffer: AudioBuffer | null;
    ambientSource: AudioBufferSourceNode | null;
    ambientGain: GainNode | null;
  }>({
    ctx: null,
    buffer: null,
    torpedoHitBuffer: null,
    explosionBuffer: null,
    deckGunFireBuffer: null,
    torpedoFireBuffer: null,
    reloadKnockBuffer: null,
    creakBuffer: null,
    ventingBuffer: null,
    ambientBuffer: null,
    subAmbientBuffers: {},
    subAmbientBand: null,
    sonarPingBuffer: null,
    ambientSource: null,
    ambientGain: null,
  });
  /** Latest close-aboard enemy ping cues for the Controls hull-hear interval. */
  const bridgeSonarPingsRef = useRef<NonNullable<VesselView['bridgeActiveSonarPings']>>([]);

  const ensureBridgeAudioCtx = async (): Promise<AudioContext> => {
    if (!bridgeAudioRef.current.ctx || bridgeAudioRef.current.ctx.state === 'closed') {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      bridgeAudioRef.current.ctx = new Ctx();
      bridgeAudioRef.current.buffer = null;
      bridgeAudioRef.current.torpedoHitBuffer = null;
      bridgeAudioRef.current.explosionBuffer = null;
      bridgeAudioRef.current.deckGunFireBuffer = null;
      bridgeAudioRef.current.torpedoFireBuffer = null;
      bridgeAudioRef.current.reloadKnockBuffer = null;
      bridgeAudioRef.current.creakBuffer = null;
      bridgeAudioRef.current.ventingBuffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
      bridgeAudioRef.current.subAmbientBuffers = {};
      bridgeAudioRef.current.subAmbientBand = null;
      bridgeAudioRef.current.sonarPingBuffer = null;
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

  const ensureReloadKnockBuffer = async (ctx: AudioContext): Promise<AudioBuffer | null> => {
    if (bridgeAudioRef.current.reloadKnockBuffer) return bridgeAudioRef.current.reloadKnockBuffer;
    try {
      bridgeAudioRef.current.reloadKnockBuffer = await loadTorpedoReloadKnockBuffer(ctx);
      return bridgeAudioRef.current.reloadKnockBuffer;
    } catch {
      return null;
    }
  };

  /** Play queued bridge blasts (close DC + torpedo/aircraft-bomb hits). */
  const flushBridgeBlastAudio = async (): Promise<void> => {
    const pending = pendingBridgeBlastRef.current;
    if (!pending.length) return;
    const ctx = await ensureBridgeAudioCtx();
    if (ctx.state !== 'running') return;

    const isExplosionCue = (kind: string) =>
      kind === 'torpedo_hit' ||
      kind === 'aircraft_bomb' ||
      kind === 'deck_gun_hit';
    const needsDc = pending.some((e) => e.kind === 'depth_charge');
    const needsTorpedoHit = pending.some((e) => e.kind === 'torpedo_hit');
    const needsSharedExplosion = pending.some(
      (e) => e.kind === 'aircraft_bomb' || e.kind === 'deck_gun_hit',
    );
    const needsGunFire = pending.some((e) => e.kind === 'deck_gun_fire');
    const needsTubeDoor = pending.some((e) => e.kind === 'torpedo_fire');
    // Load samples independently — a DC fetch failure must not block torpedo hits
    // (and vice versa). Same unlock/queue pattern as the nearby-DC bridge fix.
    if (needsDc && !bridgeAudioRef.current.buffer) {
      try {
        bridgeAudioRef.current.buffer = await loadDepthChargeBuffer(ctx);
      } catch {
        /* keep pending DC; unlock may retry */
      }
    }
    if (needsTorpedoHit && !bridgeAudioRef.current.torpedoHitBuffer) {
      try {
        bridgeAudioRef.current.torpedoHitBuffer = await loadTorpedoHitBuffer(ctx);
      } catch {
        /* keep pending hits; unlock may retry */
      }
    }
    if (needsSharedExplosion && !bridgeAudioRef.current.explosionBuffer) {
      try {
        bridgeAudioRef.current.explosionBuffer = await loadExplosionBuffer(ctx);
      } catch {
        /* keep pending bomb/gun hits; unlock may retry */
      }
    }
    if (needsGunFire && !bridgeAudioRef.current.deckGunFireBuffer) {
      try {
        bridgeAudioRef.current.deckGunFireBuffer = await loadDeckGunFireBuffer(ctx);
      } catch {
        /* keep pending gun fire; unlock may retry */
      }
    }
    if (needsTubeDoor && !bridgeAudioRef.current.torpedoFireBuffer) {
      try {
        bridgeAudioRef.current.torpedoFireBuffer = await loadTorpedoFireBuffer(ctx);
      } catch {
        /* keep pending tube doors; unlock may retry */
      }
    }
    const dcBuffer = bridgeAudioRef.current.buffer;
    const torpedoHitBuffer = bridgeAudioRef.current.torpedoHitBuffer;
    const explosionBuffer = bridgeAudioRef.current.explosionBuffer;
    const gunFireBuffer = bridgeAudioRef.current.deckGunFireBuffer;
    const tubeDoorBuffer = bridgeAudioRef.current.torpedoFireBuffer;
    const still: Array<{
      id: string;
      rangeNm: number;
      kind:
        | 'depth_charge'
        | 'torpedo_hit'
        | 'torpedo_fire'
        | 'aircraft_bomb'
        | 'deck_gun_fire'
        | 'deck_gun_hit';
      audioDelaySec?: number;
    }> = [];

    // Multi-charge patterns arrive as one hear-batch after resolve — stagger
    // one distant-explosion one-shot per charge across ~1.5 minutes (not stacked).
    const dcBatch = pending
      .filter((e) => e.kind === 'depth_charge' && !playedBridgeBlastRef.current.has(e.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const dcWhenById = depthChargeBatchWhenSecById(dcBatch);

    // Same-moment multi-fish hits share audioDelaySec — add a short onset stagger
    // so Controls can count bangs (physics / resolve unchanged).
    const hitBatch = pending.filter(
      (e) => e.kind === 'torpedo_hit' && !playedBridgeBlastRef.current.has(e.id),
    );
    const hitWhenById = torpedoHitBatchWhenSecById(hitBatch);

    // Multi-volley deck-gun fire: one cannon report per volley, staggered ~2 s.
    const gunFireBatch = pending.filter(
      (e) => e.kind === 'deck_gun_fire' && !playedBridgeBlastRef.current.has(e.id),
    );
    const gunFireWhenById = deckGunFireBatchWhenSecById(gunFireBatch);

    // Multi-fish torpedo salvos: one tube-door per fish, staggered ~0.8 s.
    const tubeDoorBatch = pending.filter(
      (e) => e.kind === 'torpedo_fire' && !playedBridgeBlastRef.current.has(e.id),
    );
    const tubeDoorWhenById = torpedoFireBatchWhenSecById(tubeDoorBatch);

    for (const e of pending) {
      if (playedBridgeBlastRef.current.has(e.id)) continue;
      try {
        if (e.kind === 'deck_gun_fire') {
          if (!gunFireBuffer) {
            still.push(e);
            continue;
          }
          playDeckGunFireSample(
            ctx,
            gunFireBuffer,
            ctx.destination,
            DECK_GUN_FIRE_CONTROLS_PEAK_GAIN,
            { whenSec: gunFireWhenById.get(e.id) ?? Math.max(0, e.audioDelaySec ?? 0) },
          );
        } else if (e.kind === 'torpedo_fire') {
          if (!tubeDoorBuffer) {
            still.push(e);
            continue;
          }
          playTorpedoFireSample(
            ctx,
            tubeDoorBuffer,
            ctx.destination,
            TORPEDO_FIRE_CONTROLS_PEAK_GAIN,
            { whenSec: tubeDoorWhenById.get(e.id) ?? Math.max(0, e.audioDelaySec ?? 0) },
          );
        } else if (isExplosionCue(e.kind)) {
          const isTorpedo = e.kind === 'torpedo_hit';
          const sampleBuffer = isTorpedo ? torpedoHitBuffer : explosionBuffer;
          if (!sampleBuffer) {
            still.push(e);
            continue;
          }
          // Floor so distant firer/target still hear a clear blast, not a tick.
          // Torpedo uses a quieter peak; bomb / deck-gun keep the prior explosion peak.
          const peak = isTorpedo ? TORPEDO_HIT_CONTROLS_PEAK_GAIN : EXPLOSION_CONTROLS_PEAK_GAIN;
          const gain = peak * Math.max(0.35, torpedoHitControlsGain(e.rangeNm));
          // Torpedo: compressed turn delay + same-moment multi-hit stagger.
          // Aircraft bomb / deck-gun hit: compressed (or short fixed) delay only.
          const whenSec = isTorpedo
            ? (hitWhenById.get(e.id) ?? Math.max(0, e.audioDelaySec ?? 0))
            : Math.max(0, e.audioDelaySec ?? 0);
          playTorpedoHitSample(ctx, sampleBuffer, ctx.destination, gain, { whenSec });
          scheduleDamageRevealRef.current(e.id, whenSec);
        } else {
          if (!dcBuffer) {
            still.push(e);
            continue;
          }
          const whenSec = dcWhenById.get(e.id) ?? 0;
          // Quintic range × damage-band boost (≤65/140/225 m); ceiling avoids clip.
          const peak = depthChargeControlsPeakGain(e.rangeNm);
          if (peak < 0.001) {
            playedBridgeBlastRef.current.add(e.id);
            scheduleDamageRevealRef.current(e.id, whenSec);
            continue;
          }
          playDepthChargeSample(ctx, dcBuffer, ctx.destination, peak, { whenSec });
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

  /**
   * Destroyer Controls ambient bed: quiet looping facility hum.
   * Submarine Controls use depth-banded loops below (not this hum).
   */
  useEffect(() => {
    if (!onControlsBridge || onSubCreakBridge) return;
    let cancelled = false;
    let starting = false;

    const stopAmbient = () => {
      const voice = bridgeAudioRef.current;
      if (voice.ambientSource && voice.ambientGain) {
        stopAmbientLoopVoice({ source: voice.ambientSource, gain: voice.ambientGain });
      }
      voice.ambientSource = null;
      voice.ambientGain = null;
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
      bridgeAudioRef.current.explosionBuffer = null;
      bridgeAudioRef.current.deckGunFireBuffer = null;
      bridgeAudioRef.current.torpedoFireBuffer = null;
      bridgeAudioRef.current.reloadKnockBuffer = null;
      bridgeAudioRef.current.creakBuffer = null;
      bridgeAudioRef.current.ventingBuffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
      bridgeAudioRef.current.subAmbientBuffers = {};
      bridgeAudioRef.current.subAmbientBand = null;
      bridgeAudioRef.current.sonarPingBuffer = null;
      playedBridgeBlastRef.current.clear();
      playedOwnReloadKnockTurnRef.current = null;
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [onControlsBridge, onSubCreakBridge]);

  const surfaced = vessel ? isRadarSurfaced(vessel.unit.position) : true;
  /** Resolve-truth keel — Sensors chrome / sonar hear gates (not ambient bands). */
  const depthM = vessel?.unit.position.depth ?? 0;
  /**
   * Ambient bands track the shared Dive needle ({@link displayedKeelDepthM}),
   * same clock as crush-implosion reveal — not the resolve-jump sim keel.
   */
  subDepthRef.current = displayedKeelDepthM;
  const atPeriscopeDepth = depthM <= PERISCOPE_DEPTH_M;
  const subAmbientBand = onSubCreakBridge
    ? subAmbientBandForDepth(displayedKeelDepthM)
    : null;
  bridgeSonarPingsRef.current = vessel?.bridgeActiveSonarPings ?? [];
  /** Hull-coupled enemy pings: submerged sub Controls with at least one close emitter. */
  const hearBridgeSonar =
    onSubCreakBridge &&
    depthM > RADAR_SURFACE_DEPTH_M &&
    (vessel?.bridgeActiveSonarPings?.length ?? 0) > 0;
  /**
   * Own-ship active-search ambience on destroyer Controls while sonar is ON.
   * Sensors keeps the louder ActiveSonarScope path — this gate is Controls-only.
   * VesselView omits `sensors`; station caps + toggle + subsystem mirror
   * {@link isActiveSonarPinging} for the FoW unit pick.
   */
  const hearOwnControlsSonar =
    onControlsBridge &&
    canActiveSonar &&
    presentationSensors.activeSonarEnabled &&
    vessel != null &&
    syncedDamage.condition !== 'sunk' &&
    syncedDamage.condition !== 'sinking' &&
    presentationSubs.activeSonar !== 'disabled';

  /**
   * Submarine Controls ambient: depth-banded loops with crossfade on band change.
   * Band follows Dive DEPTH needle ({@link subDepthRef} / displayedKeelDepthM).
   * Replaces facility hum + ambient creak one-shots + deep-hull clank loop.
   * Deep-band gain also tracks the needle (90→140 m ramp); crush gain stays flat.
   */
  useEffect(() => {
    if (!onSubCreakBridge || !subAmbientBand) return;
    let cancelled = false;
    let switching = false;

    const ensureBandBuffer = async (
      ctx: AudioContext,
      band: SubAmbientBand,
    ): Promise<AudioBuffer | null> => {
      const cached = bridgeAudioRef.current.subAmbientBuffers[band];
      if (cached) return cached;
      try {
        const buf = await loadSubAmbientBuffer(ctx, band);
        bridgeAudioRef.current.subAmbientBuffers[band] = buf;
        return buf;
      } catch {
        return null;
      }
    };

    const applyBand = async (band: SubAmbientBand, fadeSec: number) => {
      if (cancelled || switching) return;
      if (bridgeAudioRef.current.subAmbientBand === band && bridgeAudioRef.current.ambientSource) {
        return;
      }
      switching = true;
      try {
        const ctx = await ensureBridgeAudioCtx();
        if (cancelled) return;
        const buffer = await ensureBandBuffer(ctx, band);
        if (!buffer || cancelled || ctx.state !== 'running') return;
        // Re-check after await — a newer depth may have won.
        if (subAmbientBandForDepth(subDepthRef.current) !== band) return;
        const prev =
          bridgeAudioRef.current.ambientSource && bridgeAudioRef.current.ambientGain
            ? {
                source: bridgeAudioRef.current.ambientSource,
                gain: bridgeAudioRef.current.ambientGain,
              }
            : null;
        const next = crossfadeAmbientLoop(
          ctx,
          buffer,
          ctx.destination,
          prev,
          subAmbientGainForDepth(subDepthRef.current),
          fadeSec,
        );
        bridgeAudioRef.current.ambientSource = next.source;
        bridgeAudioRef.current.ambientGain = next.gain;
        bridgeAudioRef.current.subAmbientBand = band;
        await flushBridgeBlastAudio();
      } catch {
        /* autoplay / sample — unlock may retry */
      } finally {
        switching = false;
        if (!cancelled) {
          const want = subAmbientBandForDepth(subDepthRef.current);
          if (want !== bridgeAudioRef.current.subAmbientBand) {
            void applyBand(
              want,
              subAmbientCrossfadeSec(bridgeAudioRef.current.subAmbientBand, want),
            );
          }
        }
      }
    };

    const unlock = () => {
      const want = subAmbientBandForDepth(subDepthRef.current);
      void applyBand(
        want,
        subAmbientCrossfadeSec(bridgeAudioRef.current.subAmbientBand, want),
      );
      void flushBridgeBlastAudio();
    };

    void applyBand(
      subAmbientBand,
      bridgeAudioRef.current.ambientSource
        ? subAmbientCrossfadeSec(bridgeAudioRef.current.subAmbientBand, subAmbientBand)
        : 0.35,
    );
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      // Band changes re-run this effect; leave/teardown stops the voice below.
    };
  }, [onSubCreakBridge, subAmbientBand]);

  /**
   * Within the deep band, ramp ambient gain with the Dive needle (deeper → louder).
   * Shallow / crush gains are constant; this effect is a no-op-ish ramp to the same peak.
   */
  useEffect(() => {
    if (!onSubCreakBridge) return;
    const ctx = bridgeAudioRef.current.ctx;
    const gainNode = bridgeAudioRef.current.ambientGain;
    const source = bridgeAudioRef.current.ambientSource;
    if (!ctx || !gainNode || !source || ctx.state !== 'running') return;
    // Avoid fighting an in-progress band crossfade (gain is under linearRamp there).
    if (bridgeAudioRef.current.subAmbientBand !== subAmbientBandForDepth(displayedKeelDepthM)) {
      return;
    }
    rampAmbientLoopGain(
      ctx,
      { source, gain: gainNode },
      subAmbientGainForDepth(displayedKeelDepthM),
      0.25,
    );
  }, [onSubCreakBridge, displayedKeelDepthM]);

  // Tear down sub ambient + shared bridge ctx when leaving Controls.
  useEffect(() => {
    if (!onSubCreakBridge) return;
    return () => {
      const voice = bridgeAudioRef.current;
      if (voice.ambientSource && voice.ambientGain) {
        stopAmbientLoopVoice({ source: voice.ambientSource, gain: voice.ambientGain });
      }
      voice.ambientSource = null;
      voice.ambientGain = null;
      voice.subAmbientBand = null;
      const ctx = bridgeAudioRef.current.ctx;
      bridgeAudioRef.current.ctx = null;
      bridgeAudioRef.current.buffer = null;
      bridgeAudioRef.current.torpedoHitBuffer = null;
      bridgeAudioRef.current.explosionBuffer = null;
      bridgeAudioRef.current.deckGunFireBuffer = null;
      bridgeAudioRef.current.torpedoFireBuffer = null;
      bridgeAudioRef.current.reloadKnockBuffer = null;
      bridgeAudioRef.current.creakBuffer = null;
      bridgeAudioRef.current.ventingBuffer = null;
      bridgeAudioRef.current.ambientBuffer = null;
      bridgeAudioRef.current.subAmbientBuffers = {};
      bridgeAudioRef.current.sonarPingBuffer = null;
      playedBridgeBlastRef.current.clear();
      playedOwnReloadKnockTurnRef.current = null;
      if (ctx && ctx.state !== 'closed') void ctx.close();
    };
  }, [onSubCreakBridge]);

  // Submarine Controls: own-ship reload knock burst (start turn + linger).
  useEffect(() => {
    if (!onSubCreakBridge || !vessel) {
      playedOwnReloadKnockTurnRef.current = null;
      return;
    }
    const cueTurn = vessel.unit.torpedoReloadAcousticTurn;
    const turn = vessel.turn.number;
    if (!isHydrophoneReloadCueLive(cueTurn, turn)) {
      playedOwnReloadKnockTurnRef.current = null;
      return;
    }
    if (playedOwnReloadKnockTurnRef.current === turn) return;
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await ensureBridgeAudioCtx();
        if (cancelled || ctx.state !== 'running') return;
        const buffer = await ensureReloadKnockBuffer(ctx);
        if (!buffer || cancelled) return;
        if (playedOwnReloadKnockTurnRef.current === turn) return;
        playTorpedoReloadKnockCouplet(
          ctx,
          buffer,
          ctx.destination,
          TORPEDO_RELOAD_KNOCK_CONTROLS_PEAK_GAIN,
        );
        playedOwnReloadKnockTurnRef.current = turn;
      } catch {
        /* autoplay / sample — ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    onSubCreakBridge,
    vessel?.unit.torpedoReloadAcousticTurn,
    vessel?.turn.number,
    vessel?.stateVersion,
  ]);

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

  // Sub Controls: hull-coupled nearby enemy active-sonar pings (same 6 s cadence).
  // Volume from proximity only — silent beyond ACTIVE_SONAR_CONTROLS_AUDIBLE_NM.
  // Cadence-only: do NOT re-fire on pointer/key unlock (that replayed the ping on
  // every Controls click). Ambient unlock already resumes the shared AudioContext.
  useEffect(() => {
    if (!hearBridgeSonar) return;
    let cancelled = false;
    let timer: number | null = null;

    const playBridgePings = async () => {
      if (cancelled) return;
      const pings = bridgeSonarPingsRef.current;
      if (!pings.length) return;
      try {
        const ctx = await ensureBridgeAudioCtx();
        if (cancelled || ctx.state !== 'running') return;
        if (!bridgeAudioRef.current.sonarPingBuffer) {
          bridgeAudioRef.current.sonarPingBuffer = await loadSonarPingBuffer(ctx);
        }
        const buffer = bridgeAudioRef.current.sonarPingBuffer;
        if (!buffer || cancelled) return;
        for (const ping of pings) {
          const peak = activeSonarControlsPeakGain(ping.rangeNm);
          if (peak < 0.001) continue;
          playSonarPingSample(ctx, buffer, ctx.destination, peak);
        }
      } catch {
        /* autoplay / sample — ignore */
      }
    };

    void playBridgePings();
    timer = window.setInterval(() => void playBridgePings(), ACTIVE_SONAR_PING_INTERVAL_SEC * 1000);

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [hearBridgeSonar]);

  // Destroyer Controls: faint own-ship ping while search sonar is ON (same sample
  // + 6 s cadence as Sensors). Stops on toggle OFF, sonar disabled, or leave Controls.
  // Cadence-only — no gesture unlock re-fire (see hearBridgeSonar above).
  useEffect(() => {
    if (!hearOwnControlsSonar) return;
    let cancelled = false;
    let timer: number | null = null;

    const playOwnControlsPing = async () => {
      if (cancelled) return;
      try {
        const ctx = await ensureBridgeAudioCtx();
        if (cancelled || ctx.state !== 'running') return;
        if (!bridgeAudioRef.current.sonarPingBuffer) {
          bridgeAudioRef.current.sonarPingBuffer = await loadSonarPingBuffer(ctx);
        }
        const buffer = bridgeAudioRef.current.sonarPingBuffer;
        if (!buffer || cancelled) return;
        playSonarPingSample(ctx, buffer, ctx.destination, SONAR_PING_CONTROLS_OWN_GAIN);
      } catch {
        /* autoplay / sample — ignore */
      }
    };

    void playOwnControlsPing();
    timer = window.setInterval(
      () => void playOwnControlsPing(),
      ACTIVE_SONAR_PING_INTERVAL_SEC * 1000,
    );

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [hearOwnControlsSonar]);

  // Sub Controls: underwater depth-change cue when keel moves on resolve toward
  // a *new* ordered depth. Silent on UI submit; silent when holding depth; silent
  // on later transit resolves that are still chasing the same set-point.
  // Emergency Blow (Dive preset): venting + hull creak each ascent resolve;
  // depth bed still once per ordered set-point (ducked under venting).
  useEffect(() => {
    if (!onSubCreakBridge || !vessel) {
      depthChangeSfxRef.current = null;
      return;
    }
    const unitId = vessel.unit.id;
    const keel = vessel.unit.position.depth;
    const ordered = vessel.unit.orderedDepth ?? keel;
    const turn = vessel.turn.number;
    const prev = depthChangeSfxRef.current;
    if (!prev || prev.unitId !== unitId) {
      depthChangeSfxRef.current = {
        unitId,
        depth: keel,
        orderedDepth: ordered,
        turn,
        playedForOrderedDepth: null,
      };
      return;
    }
    const nextSnap = { unitId, depth: keel, orderedDepth: ordered, turn };
    const playDepthBed = shouldPlaySubDepthChangeSfx(prev, nextSnap);
    const ascending = turn > prev.turn && keel < prev.depth - 1e-3;
    const blowAscending = pendingEmergencyBlowRef.current && ascending;
    if (playDepthBed) {
      // Duck the long depth bed under venting so the hiss stays audible.
      void playSubDepthChange(
        blowAscending ? { peakGain: SUB_DEPTH_CHANGE_EMERGENCY_BLOW_GAIN } : undefined,
      );
    }
    if (blowAscending) {
      void (async () => {
        try {
          const ctx = await ensureBridgeAudioCtx();
          if (ctx.state !== 'running') return;
          if (!bridgeAudioRef.current.ventingBuffer) {
            bridgeAudioRef.current.ventingBuffer = await loadEmergencyBlowVentingBuffer(ctx);
          }
          const venting = bridgeAudioRef.current.ventingBuffer;
          if (venting) {
            playEmergencyBlowVentingSample(
              ctx,
              venting,
              ctx.destination,
              EMERGENCY_BLOW_VENTING_PEAK_GAIN,
            );
          }
          const creak = await ensureCreakBuffer(ctx);
          if (!creak) return;
          playSubmarineCreakSample(
            ctx,
            creak,
            ctx.destination,
            SUBMARINE_CREAK_DC_GAIN,
            { durationSec: SUBMARINE_CREAK_DC_DURATION_SEC },
          );
        } catch {
          // Optional bridge SFX — never block Controls.
        }
      })();
    }
    // Arming lifecycle: latch when ordered 0 is observed; clear at surface or
    // only cancel on ordered>0 *after* that latch (avoids stream-race disarm).
    if (pendingEmergencyBlowRef.current) {
      if (ordered <= 0) {
        emergencyBlowOrderSeenRef.current = true;
      }
      if (keel <= RADAR_SURFACE_DEPTH_M) {
        pendingEmergencyBlowRef.current = false;
        emergencyBlowOrderSeenRef.current = false;
      } else if (ordered > 0 && emergencyBlowOrderSeenRef.current) {
        pendingEmergencyBlowRef.current = false;
        emergencyBlowOrderSeenRef.current = false;
      }
    }
    depthChangeSfxRef.current = {
      unitId,
      depth: keel,
      orderedDepth: ordered,
      turn,
      playedForOrderedDepth: playDepthBed ? ordered : prev.playedForOrderedDepth,
    };
  }, [
    onSubCreakBridge,
    vessel,
    vessel?.unit.id,
    vessel?.unit.position.depth,
    vessel?.unit.orderedDepth,
    vessel?.turn.number,
  ]);

  // Own-ship sunk popup on Controls + Sensors — wait until audio-synced
  // presentation reaches sunk (same delay as blast SFX / Damage report).
  const ownShipSunk =
    syncedDamage.condition === 'sunk' || syncedDamage.condition === 'sinking';
  const presentationSunk = ownShipSunk;
  /** Soften Sensors “sunk” copy until blast-synced presentation catches up. */
  const sunkSetOfflineBlurb = presentationSunk ? 'Set offline — sunk' : 'Set offline';
  const sunkUnavailableLine = (label: string) =>
    presentationSunk ? `${label} unavailable — sunk/destroyed` : `${label} unavailable`;
  const sunkCause = useMemo(
    () => resolveSunkCause(syncedDamage.damageLog),
    [syncedDamage.damageLog],
  );
  useEffect(() => {
    if (!vessel || !ownShipSunk) {
      sunkModalAckedRef.current = false;
      setSunkModalOpen(false);
      return;
    }
    if (sunkModalAckedRef.current) return;
    setSunkModalOpen(true);
    // Deliberately omit full `vessel` — SSE ticks must not re-open after ack.
  }, [ownShipSunk, vessel?.unit.id]);

  // Controls: keep active instrument tab valid for this hull (no generic Weapons).
  useEffect(() => {
    if (!vessel || !isControls || isSensors) return;
    const ids = new Set(controlsTabs.map((t) => t.id));
    if (!ids.has(controlsTab)) {
      setControlsTab('helm');
    }
  }, [vessel, isControls, isSensors, controlsTabs, controlsTab]);

  // Sub Sensors: pick a sensible default tab from depth; follow depth-band changes.

  // Do not depend on the whole vessel object — mast raise/lower updates must
  // not re-run this and kick the operator off Periscope.
  const hasVessel = Boolean(vessel);
  useEffect(() => {
    if (!hasVessel || !isSensors) return;
    // Destroyer Sensors: radar + active sonar + hydrophone + lookout — keep operator choice.
    if (canActiveSonar && canRadar) {
      setSensorTab((prev) => {
        if (
          prev === 'radar' ||
          prev === 'sonar' ||
          prev === 'hydrophone' ||
          prev === 'periscope'
        ) {
          return prev;
        }
        return 'radar';
      });
      return;
    }
    // Fleet-sub Sensors: depth-gated radar / peri / hydro switching.
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

  const submit = async (patch: StationOrdersPatch) => {
    if (!token || !vessel) return;
    if (!vessel.canSubmitOrders) {
      setActionError('Ordering is locked');
      return;
    }
    setActionError(null);
    const base = ordersOverlayRef.current ?? vessel.unit.orders ?? {};
    const optimistic = mergeOrdersOptimistic(base, patch, stationId);
    setOrdersOverlay(optimistic);
    ordersOverlayRef.current = optimistic;
    const gen = ++orderWriteGenRef.current;
    setOrderWriteInFlight((n) => n + 1);
    try {
      const res = await api.orders(gameId, token, patch);
      // Only the latest in-flight write may refine the overlay from POST.
      if (gen === orderWriteGenRef.current && res.orders) {
        setOrdersOverlay(res.orders);
        ordersOverlayRef.current = res.orders;
      }
    } catch (err) {
      if (gen === orderWriteGenRef.current) {
        // Revert to stream truth; a newer click may already own the overlay.
        setOrdersOverlay(null);
        ordersOverlayRef.current = null;
      }
      setActionError(err instanceof Error ? err.message : 'Order failed');
    } finally {
      setOrderWriteInFlight((n) => Math.max(0, n - 1));
    }
  };

  /** One-tap re-file standing helm / EOT / dive as this turn's of-record ORD. */
  const continueStandingOrdersPatch = vessel
    ? buildContinueStandingOrdersPatch({
        unitType: vessel.unit.type,
        orderedCourse: vessel.unit.orderedCourse,
        standingEot: vessel.unit.eot,
        orderedDepth: vessel.unit.orderedDepth,
        keelDepth: vessel.unit.position.depth,
        pending: displayOrders,
        canHelm,
        canEot,
        steeringBlocked:
          presentationSubs.steering === 'stuck' ||
          presentationSubs.steering === 'disabled',
        propulsionDisabled: presentationSubs.propulsion === 'disabled',
        divePlanesLocked:
          presentationSubs.divePlanes === 'stuck' ||
          presentationSubs.divePlanes === 'disabled',
      })
    : null;

  const continueStandingOrders = () => {
    if (!continueStandingOrdersPatch) return;
    // Keep local dials aligned with what we just affirmed of-record.
    if (continueStandingOrdersPatch.course !== undefined) {
      setCourse(Math.round(continueStandingOrdersPatch.course));
    }
    if (continueStandingOrdersPatch.eot !== undefined) {
      setEot(continueStandingOrdersPatch.eot);
    }
    if (continueStandingOrdersPatch.depth !== undefined) {
      setDepth(continueStandingOrdersPatch.depth);
    }
    void submit(continueStandingOrdersPatch);
  };

  /**
   * Local-first sonar latch: paint immediately so the toggle is not dead for a
   * full RTT. Busy briefly gates double-fire; SSE reconcile clears the overlay.
   */
  const toggleActiveSonar = (enabled: boolean) => {
    if (!token) return;
    setActionError(null);
    setSonarOptimisticEnabled(enabled);
    setSonarBusy(true);
    const gen = ++sonarWriteGenRef.current;
    void (async () => {
      try {
        await api.setActiveSonar(gameId, token, enabled);
      } catch (err) {
        if (gen !== sonarWriteGenRef.current) return;
        setSonarOptimisticEnabled(null);
        setActionError(err instanceof Error ? err.message : 'Sonar toggle failed');
      } finally {
        if (gen === sonarWriteGenRef.current) setSonarBusy(false);
      }
    })();
  };

  // Drop mast overlay once the streamed view agrees (SSE caught up).
  useEffect(() => {
    if (periOptimisticRaised === null || !vessel) return;
    // Match presentation mast (held through blast reveal), not resolve-time FoW.
    if (presentationSensors.periscopeRaised === periOptimisticRaised) {
      setPeriOptimisticRaised(null);
    }
  }, [vessel, periOptimisticRaised, presentationSensors.periscopeRaised]);

  // Authoritative peri FoW for this raise window — mark ready + refresh turn cache.
  // Keyed on stateVersion (not contact array identity) so empty `?? []` aliases
  // from presentationSensors cannot retrigger setState every render.
  useEffect(() => {
    if (!vessel || opticsVariant !== 'periscope') return;
    if (!presentationSensors.periscopeRaised) return;
    const turn = vessel.turn.number;
    const contacts = presentationSensors.periscopeContacts;
    const sightings = presentationSensors.opticsSightings;
    setPeriFowReadyGen((ready) => (ready === periRaiseGen ? ready : periRaiseGen));
    setPeriTurnFowCache({ turn, contacts, sightings });
  }, [
    opticsVariant,
    periRaiseGen,
    vessel,
    vessel?.turn.number,
    vessel?.stateVersion,
    presentationSensors.periscopeRaised,
  ]);

  /**
   * Gentle FoW catch-up after mast raise: at most two delayed GET /view polls,
   * cancelled once this raise’s FoW is ready or the mast lowers. Snapshot only —
   * never force-closes SSE / flips RECONNECTING (the #248 failure mode).
   */
  useEffect(() => {
    if (!vessel || opticsVariant !== 'periscope') return;
    if (!opticsMastRaised || opticsScopeDown) return;
    if (periFowReadyGen === periRaiseGen) return;
    const raiseGen = periRaiseGen;
    if (isWpDebugEnabled()) {
      wpDebug('softViewSchedule', {
        reason: 'periRaise',
        raiseGen,
        delaysMs: [...PERI_FOW_VIEW_REFRESH_DELAYS_MS],
      });
    }
    const timers = PERI_FOW_VIEW_REFRESH_DELAYS_MS.map((delay) =>
      window.setTimeout(() => {
        if (periDesiredRaisedRef.current === false) return;
        // Raise window may have advanced; only poll for the gen we scheduled.
        if (raiseGen !== periRaiseGenRef.current) return;
        if (isWpDebugEnabled()) {
          wpDebug('softViewFire', { reason: 'periRaise', raiseGen, delayMs: delay });
        }
        void streamRefreshRef.current('softView');
      }, delay),
    );
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [
    periRaiseGen,
    periFowReadyGen,
    opticsMastRaised,
    opticsScopeDown,
    opticsVariant,
    vessel,
  ]);

  /**
   * One-shot GET /view when the operator focuses Lookout / Periscope — remotes
   * that missed a large mid-turn `state` (DD feather) catch up without reopening
   * the live stream. Cooldown avoids a refresh storm if the tab effect re-runs.
   * Heartbeat versioned pings (#246) remain the background path.
   */
  useEffect(() => {
    const onOpticsTab = Boolean(
      vessel && isSensors && canPeriscope && activeTab === 'periscope',
    );
    const entered = onOpticsTab && !opticsTabFocusedRef.current;
    opticsTabFocusedRef.current = onOpticsTab;
    if (!entered) return;
    const now = Date.now();
    if (now - opticsTabRefreshAtRef.current < OPTICS_TAB_VIEW_REFRESH_COOLDOWN_MS) {
      return;
    }
    opticsTabRefreshAtRef.current = now;
    if (isWpDebugEnabled()) {
      wpDebug('softViewFire', { reason: 'opticsTabFocus', activeTab });
    }
    void streamRefreshRef.current('softView');
  }, [activeTab, isSensors, canPeriscope, vessel]);

  // Drop sonar overlay once the streamed latch agrees.
  useEffect(() => {
    if (sonarOptimisticEnabled === null || !vessel) return;
    if (presentationSensors.activeSonarEnabled === sonarOptimisticEnabled) {
      setSonarOptimisticEnabled(null);
    }
  }, [vessel, sonarOptimisticEnabled, presentationSensors.activeSonarEnabled]);

  // Drop reload overlays once SSE awaiting flags catch up.
  useEffect(() => {
    if (!vessel) return;
    setReloadOptimistic((prev) => {
      let changed = false;
      const next = { ...prev };
      if (prev.torpedoForward && vessel.unit.torpedoForwardAwaitingReload) {
        delete next.torpedoForward;
        changed = true;
      }
      if (prev.torpedoAft && vessel.unit.torpedoAftAwaitingReload) {
        delete next.torpedoAft;
        changed = true;
      }
      if (prev.depthCharges && vessel.unit.depthChargeAwaitingReload) {
        delete next.depthCharges;
        changed = true;
      }
      if (prev.deckGun && vessel.unit.deckGunAwaitingReload) {
        delete next.deckGun;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [
    vessel,
    vessel?.unit.torpedoForwardAwaitingReload,
    vessel?.unit.torpedoAftAwaitingReload,
    vessel?.unit.depthChargeAwaitingReload,
    vessel?.unit.deckGunAwaitingReload,
  ]);

  useEffect(() => {
    return () => {
      if (periWriteTimerRef.current != null) {
        window.clearTimeout(periWriteTimerRef.current);
      }
    };
  }, []);

  /**
   * Local-first mast toggle: paint immediately, debounce the POST so remote
   * RTT / rapid clicks do not serialize UI behind every round-trip.
   */
  const togglePeriscope = (raised: boolean) => {
    if (!token) return;
    setActionError(null);
    setPeriOptimisticRaised(raised);
    periDesiredRaisedRef.current = raised;
    if (isWpDebugEnabled()) {
      wpDebug('mastToggle', {
        desired: raised,
        serverMast: presentationSensors.periscopeRaised,
        periRaiseGen,
        periFowReadyGen,
        stateVersion,
        connected,
      });
    }
    if (raised) {
      // New raise window — wait for streamed FoW (or show turn cache / “Raising…”).
      setPeriRaiseGen((g) => g + 1);
    } else {
      // Mast down — next raise is a new window; keep turn cache for re-raise.
      setPeriFowReadyGen(-1);
    }
    if (periWriteTimerRef.current != null) {
      window.clearTimeout(periWriteTimerRef.current);
    }
    setPeriBusy(true);
    const gen = ++periWriteGenRef.current;
    periWriteTimerRef.current = window.setTimeout(() => {
      periWriteTimerRef.current = null;
      const desired = periDesiredRaisedRef.current;
      if (desired === null) return;
      void (async () => {
        try {
          await api.setPeriscope(gameId, token, desired);
        } catch (err) {
          if (gen !== periWriteGenRef.current) return;
          setPeriOptimisticRaised(null);
          periDesiredRaisedRef.current = null;
          setActionError(
            err instanceof Error ? err.message : 'Periscope toggle failed',
          );
        } finally {
          if (gen === periWriteGenRef.current) setPeriBusy(false);
        }
      })();
    }, PERISCOPE_WRITE_DEBOUNCE_MS);
  };

  const reloadTorpedoRoom = async (room: 'forward' | 'aft') => {
    if (!token) return;
    setActionError(null);
    setReloadOptimistic((prev) => ({
      ...prev,
      ...(room === 'forward' ? { torpedoForward: true } : { torpedoAft: true }),
    }));
    setWeaponReloadBusy(true);
    try {
      await api.startTorpedoReload(gameId, token, room);
    } catch (err) {
      setReloadOptimistic((prev) => {
        const next = { ...prev };
        if (room === 'forward') delete next.torpedoForward;
        else delete next.torpedoAft;
        return next;
      });
      setActionError(err instanceof Error ? err.message : 'Torpedo reload failed');
    } finally {
      setWeaponReloadBusy(false);
    }
  };

  const reloadDepthCharges = async () => {
    if (!token) return;
    setActionError(null);
    setReloadOptimistic((prev) => ({ ...prev, depthCharges: true }));
    setWeaponReloadBusy(true);
    try {
      await api.startDepthChargeReload(gameId, token);
    } catch (err) {
      setReloadOptimistic((prev) => {
        const next = { ...prev };
        delete next.depthCharges;
        return next;
      });
      setActionError(err instanceof Error ? err.message : 'Depth-charge reload failed');
    } finally {
      setWeaponReloadBusy(false);
    }
  };

  const reloadDeckGun = async () => {
    if (!token) return;
    setActionError(null);
    setReloadOptimistic((prev) => ({ ...prev, deckGun: true }));
    setWeaponReloadBusy(true);
    try {
      await api.startDeckGunReload(gameId, token);
    } catch (err) {
      setReloadOptimistic((prev) => {
        const next = { ...prev };
        delete next.deckGun;
        return next;
      });
      setActionError(err instanceof Error ? err.message : 'Deck-gun reload failed');
    } finally {
      setWeaponReloadBusy(false);
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
      <div className={`app-shell${vessel && (sensorFocus || (isControls && !isSensors)) ? ' app-shell--radar-focus' : ''}`}>
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
          {vessel && (
            <TurnStatus turn={vessel.turn} turnLengthSeconds={vessel.turnLengthSeconds} />
          )}
          <div className="stack" style={{ alignItems: 'flex-end', gap: '0.35rem' }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <span className={`live-dot ${connected ? '' : 'off'}`} />
              <span className={`mono muted`}>
                {connected ? 'LIVE' : 'RECONNECTING'}
              </span>
              <span className="mono muted">v{stateVersion}</span>
            </div>
          </div>
        </header>

        {(error || actionError) && <p className="error">{error || actionError}</p>}

        {vessel && vessel.unit.gopherTask?.status === 'active' && (
          <div className="gopher-cue-banner" role="status" aria-live="polite">
            <span className="gopher-cue-key">GOPHER TASK</span>
            <span className="readout">
              {vessel.unit.gopherTask.label ?? vessel.unit.gopherTask.text}
            </span>
            {isControls && controlsTab !== 'damage' && (
              <button
                type="button"
                className="gopher-cue-jump"
                onClick={() => setControlsTab('damage')}
              >
                View on Damage →
              </button>
            )}
          </div>
        )}

        {vessel && sunkModalOpen && (
          <SunkModal
            vesselName={vessel.unit.name}
            vesselType={vessel.unit.type}
            cause={sunkCause}
            // Tipperary only on Controls — Sensors (hydro/radar/sonar/optics) stay silent.
            playFarewellMusic={isControls && !isSensors}
            onAcknowledge={() => {
              sunkModalAckedRef.current = true;
              setSunkModalOpen(false);
            }}
          />
        )}

        {vessel && isSensors && (
          <>
            {expectedMove && (
              <section
                className="panel controls-status-strip sensors-move-strip"
                aria-label="Expected move this turn"
              >
                <div className="controls-status-grid controls-status-grid--move-only">
                  <MoveDistanceReadout
                    distanceNm={expectedMove.distanceNm}
                    speedKn={expectedMove.speedKn}
                    turnLengthSeconds={vessel.turnLengthSeconds}
                  />
                </div>
              </section>
            )}
            {(canRadar && canHydrophone) ||
            (canRadar && canActiveSonar) ||
            (canRadar && canPeriscope) ||
            (canActiveSonar && canPeriscope) ||
            (canActiveSonar && canHydrophone) ||
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
              <section className="panel stack station-instrument-panel">
                <div className="station-instrument-head">
                  {guideRadar ? (
                    <StationInstrumentTitle title="Radar · PPI" guideId={guideRadar} />
                  ) : (
                    <h2>Radar · PPI</h2>
                  )}
                  <p className="muted station-instrument-blurb">
                    {presentationSensors.radarUnavailableReason === 'submerged'
                      ? ''
                      : presentationSensors.radarOperational
                        ? `Surface search · ${vessel.radarMaxRangeNm ?? 25} nm`
                        : presentationSensors.radarUnavailableReason === 'no_sensor'
                          ? 'No radar set installed'
                          : presentationSensors.radarUnavailableReason === 'sunk'
                            ? sunkSetOfflineBlurb
                            : presentationSensors.radarUnavailableReason ===
                                'sensors_disabled'
                              ? 'Sensors disabled'
                              : ''}
                  </p>
                </div>
                {presentationSensors.radarOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {presentationSensors.radarUnavailableReason === 'submerged'
                        ? 'Radar unavailable — submerged'
                        : presentationSensors.radarUnavailableReason === 'sunk'
                          ? sunkUnavailableLine('Radar')
                          : presentationSensors.radarUnavailableReason ===
                              'sensors_disabled'
                            ? 'Radar unavailable — sensors disabled'
                            : presentationSensors.radarUnavailableReason === 'no_sensor'
                              ? 'Radar unavailable — no sensor'
                              : 'Radar unavailable'}
                    </p>
                  </div>
                ) : (
                  <RadarScope
                    contacts={presentationSensors.radarContacts}
                    maxRangeNm={vessel.radarMaxRangeNm ?? 25}
                    ownHeading={vessel.unit.heading}
                  />
                )}
              </section>
            )}

            {canPeriscope && activeTab === 'periscope' && (
              <section className="panel stack station-instrument-panel">
                <div className="station-instrument-head">
                  {guideOptics ? (
                    <StationInstrumentTitle
                      title={
                        opticsVariant === 'lookout'
                          ? 'Lookout · Visual'
                          : 'Periscope · Visual'
                      }
                      guideId={guideOptics}
                    />
                  ) : (
                    <h2>
                      {opticsVariant === 'lookout'
                        ? 'Lookout · Visual'
                        : 'Periscope · Visual'}
                    </h2>
                  )}
                  <p className="muted station-instrument-blurb">
                    {opticsVariant === 'lookout'
                      ? presentationSensors.periscopeOperational
                        ? `Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · bridge lookout`
                        : presentationSensors.periscopeUnavailableReason === 'no_sensor'
                          ? 'No lookout set installed'
                          : presentationSensors.periscopeUnavailableReason === 'sunk'
                            ? sunkSetOfflineBlurb
                            : ''
                      : presentationSensors.periscopeOperational || opticsMastRaised
                        ? `Visual · ${vessel.periscopeMaxRangeNm ?? 6} nm · mast UP · depth ≤ ${PERISCOPE_DEPTH_M} m`
                        : presentationSensors.periscopeUnavailableReason === 'scope_down' ||
                            opticsScopeDown
                          ? 'Mast DOWN — blind'
                          : presentationSensors.periscopeUnavailableReason === 'too_deep'
                            ? `Depth ≤ ${PERISCOPE_DEPTH_M} m required`
                            : presentationSensors.periscopeUnavailableReason === 'no_sensor'
                              ? 'No periscope set installed'
                              : presentationSensors.periscopeUnavailableReason === 'sunk'
                                ? sunkSetOfflineBlurb
                                : presentationSensors.periscopeUnavailableReason ===
                                    'sensors_disabled'
                                  ? 'Sensors disabled'
                                  : ''}
                  </p>
                </div>
                {opticsVariant === 'periscope' && (
                  <div className="stack" style={{ gap: '0.5rem' }}>
                    <div className="sonar-toggle-row station-latch-row">
                      <button
                        type="button"
                        className={[
                          'station-latch',
                          opticsMastRaised ? 'station-latch--raised' : 'station-latch--lowered',
                          periBusy ? 'is-pending' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={
                          periBusy ||
                          presentationSensors.periscopeUnavailableReason === 'no_sensor' ||
                          presentationSensors.periscopeUnavailableReason === 'sunk' ||
                          presentationSensors.periscopeUnavailableReason ===
                            'sensors_disabled' ||
                          (!opticsMastRaised &&
                            (presentationSensors.periscopeUnavailableReason === 'too_deep' ||
                              vessel.unit.position.depth > PERISCOPE_DEPTH_M))
                        }
                        aria-pressed={opticsMastRaised}
                        aria-busy={periBusy || undefined}
                        aria-label={
                          opticsMastRaised
                            ? 'Periscope mast raised — click to lower'
                            : 'Periscope mast lowered — click to raise'
                        }
                        onClick={() => togglePeriscope(!opticsMastRaised)}
                      >
                        <span
                          className={`station-latch-glyph station-latch-glyph--mast${
                            opticsMastRaised ? ' is-up' : ' is-down'
                          }`}
                          aria-hidden
                        />
                        <span className="station-latch-copy">
                          <span className="station-latch-state">
                            {opticsMastRaised ? 'MAST RAISED' : 'MAST LOWERED'}
                          </span>
                          <span className="station-latch-action">
                            {opticsMastRaised ? 'Lower periscope' : 'Raise periscope'}
                          </span>
                        </span>
                      </button>
                      <span className="mono muted station-latch-hint">
                        {opticsMastRaised ? 'Scope live' : 'Blind · not spottable'}
                      </span>
                    </div>
                  </div>
                )}
                {opticsHardUnavailable ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {presentationSensors.periscopeUnavailableReason === 'too_deep'
                        ? 'Periscope unavailable — too deep'
                        : presentationSensors.periscopeUnavailableReason === 'sunk'
                          ? sunkUnavailableLine(opticsTabLabel)
                          : presentationSensors.periscopeUnavailableReason ===
                              'sensors_disabled'
                            ? `${opticsTabLabel} unavailable — sensors disabled`
                            : presentationSensors.periscopeUnavailableReason === 'no_sensor'
                              ? `${opticsTabLabel} unavailable — no sensor`
                              : `${opticsTabLabel} unavailable`}
                    </p>
                  </div>
                ) : (
                  <PeriscopeScope
                    contacts={opticsContacts}
                    sightings={opticsSightings}
                    maxRangeNm={vessel.periscopeMaxRangeNm ?? 6}
                    ownHeading={opticsOwnHeading}
                    variant={opticsVariant}
                    blind={opticsScopeDown}
                    raising={opticsRaising}
                  />
                )}
              </section>
            )}

            {canHydrophone && activeTab === 'hydrophone' && (
              <section className="panel stack station-instrument-panel">
                <div className="station-instrument-head">
                  {guideHydrophone ? (
                    <StationInstrumentTitle
                      title="Hydrophone · Bearing listen"
                      guideId={guideHydrophone}
                    />
                  ) : (
                    <h2>Hydrophone · Bearing listen</h2>
                  )}
                  <p className="muted station-instrument-blurb">
                    {presentationSensors.hydrophoneOperational
                      ? `Passive · eff ~${Math.round(vessel.hydrophoneEffectiveRangeNm ?? vessel.hydrophoneMaxRangeNm ?? 30)} / ${vessel.hydrophoneMaxRangeNm ?? 30} nm`
                      : presentationSensors.hydrophoneUnavailableReason === 'surfaced'
                        ? 'Submerged only (depth > 5 m)'
                        : presentationSensors.hydrophoneUnavailableReason === 'no_sensor'
                          ? 'No hydrophone set installed'
                          : presentationSensors.hydrophoneUnavailableReason === 'sunk'
                            ? sunkSetOfflineBlurb
                            : presentationSensors.hydrophoneUnavailableReason ===
                                'sensors_disabled'
                              ? 'Sensors disabled'
                              : ''}
                  </p>
                </div>
                {presentationSensors.hydrophoneOperational === false ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {presentationSensors.hydrophoneUnavailableReason === 'surfaced'
                        ? 'Hydrophone unavailable — surfaced'
                        : presentationSensors.hydrophoneUnavailableReason === 'sunk'
                          ? sunkUnavailableLine('Hydrophone')
                          : presentationSensors.hydrophoneUnavailableReason ===
                              'sensors_disabled'
                            ? 'Hydrophone unavailable — sensors disabled'
                            : presentationSensors.hydrophoneUnavailableReason ===
                                'no_sensor'
                              ? 'Hydrophone unavailable — no sensor'
                              : 'Hydrophone unavailable'}
                    </p>
                  </div>
                ) : (
                  <HydrophoneScope
                    contacts={presentationSensors.hydrophoneContacts}
                    maxRangeNm={vessel.hydrophoneMaxRangeNm ?? 30}
                    effectiveRangeNm={vessel.hydrophoneEffectiveRangeNm}
                    listenQuality={vessel.hydrophoneListenQuality}
                    selfNoise={vessel.hydrophoneSelfNoise}
                    ownHeading={vessel.unit.heading}
                    turnNumber={vessel.turn.number}
                    masterGain={
                      vessel.unit.class === 'Destroyer'
                        ? HYDROPHONE_MASTER_GAIN_DESTROYER
                        : HYDROPHONE_MASTER_GAIN_DEFAULT
                    }
                  />
                )}
              </section>
            )}

            {canActiveSonar && activeTab === 'sonar' && (
              <section className="panel stack station-instrument-panel">
                <div className="station-instrument-head">
                  {guideActiveSonar ? (
                    <StationInstrumentTitle
                      title="Active search sonar"
                      guideId={guideActiveSonar}
                    />
                  ) : (
                    <h2>Active search sonar</h2>
                  )}
                  <p className="muted station-instrument-blurb">
                    Cone ±{vessel.sonarHalfAngleDeg ?? 30}°
                    {vessel.sonarMaxRangeNm ? ` · max ${vessel.sonarMaxRangeNm} nm` : ''}
                  </p>
                </div>
                <div className="sonar-toggle-row station-latch-row">
                  <button
                    type="button"
                    className={[
                      'station-latch',
                      sonarLatchEnabled
                        ? 'station-latch--raised'
                        : 'station-latch--lowered',
                      sonarBusy ? 'is-pending' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    disabled={
                      sonarBusy ||
                      presentationSensors.sonarUnavailableReason === 'no_sensor' ||
                      presentationSensors.sonarUnavailableReason === 'sunk' ||
                      presentationSensors.sonarUnavailableReason === 'sensors_disabled'
                    }
                    aria-pressed={sonarLatchEnabled}
                    aria-busy={sonarBusy || undefined}
                    aria-label={
                      sonarLatchEnabled
                        ? 'Search sonar on — click to stand by'
                        : 'Search sonar standby — click to start pinging'
                    }
                    onClick={() => toggleActiveSonar(!sonarLatchEnabled)}
                  >
                    <span
                      className={`station-latch-glyph station-latch-glyph--sonar${
                        sonarLatchEnabled ? ' is-on' : ' is-off'
                      }`}
                      aria-hidden
                    />
                    <span className="station-latch-copy">
                      <span className="station-latch-state">
                        {sonarLatchEnabled ? 'SONAR SEARCH' : 'SONAR STANDBY'}
                      </span>
                      <span className="station-latch-action">
                        {sonarLatchEnabled ? 'Stop pinging' : 'Start search'}
                      </span>
                    </span>
                  </button>
                  <span className="mono muted station-latch-hint">
                    {sonarBusy
                      ? 'Sending…'
                      : sonarLatchEnabled
                        ? 'PINGING'
                        : 'Quiet'}
                  </span>
                </div>
                {presentationSensors.sonarUnavailableReason === 'no_sensor' ||
                presentationSensors.sonarUnavailableReason === 'sunk' ||
                presentationSensors.sonarUnavailableReason === 'sensors_disabled' ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      {presentationSensors.sonarUnavailableReason === 'sunk'
                        ? sunkUnavailableLine('Sonar')
                        : presentationSensors.sonarUnavailableReason === 'sensors_disabled'
                          ? 'Sonar unavailable — sensors disabled'
                          : 'Sonar unavailable — no sensor'}
                    </p>
                  </div>
                ) : !sonarLatchEnabled ? (
                  <div className="radar-unavailable" role="status">
                    <p className="readout" style={{ margin: 0 }}>
                      Active sonar standby — toggle ON to search
                    </p>
                  </div>
                ) : (
                  <ActiveSonarScope
                    contacts={presentationSensors.sonarContacts}
                    maxRangeNm={vessel.sonarMaxRangeNm ?? 8}
                    halfAngleDeg={vessel.sonarHalfAngleDeg ?? 30}
                    ownHeading={vessel.unit.heading}
                    pinging={sonarLatchEnabled}
                  />
                )}
              </section>
            )}

            {/* Turn status under sensor instruments */}

            <section className="panel stack station-turn-panel">
              <h2>Turn</h2>
              {hasPendingOrders(displayOrders) ? (
                <div className="orders-of-record" role="status">
                  <span
                    className={`status-pill ${
                      orderWritePending || ordersOverlay ? 'pending' : 'open'
                    }`}
                  >
                    {orderWritePending || ordersOverlay ? 'Updating…' : 'Submitted'}
                  </span>
                  <span className="mono readout">
                    {formatPendingOrdersSummary(displayOrders)}
                  </span>
                  {displayOrders.updatedByStationId && (
                    <span className="mono muted">via {displayOrders.updatedByStationId}</span>
                  )}
                </div>
              ) : (
                <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
                  No pending orders.
                </p>
              )}
              {vessel.stationConnections.some((c) => c.count > 1) && (
                <p className="mono" style={{ margin: 0, color: 'var(--accent-strong)' }}>
                  Multi-connection —{' '}
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
              {(() => {
                const alertEvents = syncedDamage.visibleBridgeDetonations.filter(
                  (d) =>
                    d.kind === 'depth_charge' ||
                    d.kind === 'torpedo_hit' ||
                    d.kind === 'aircraft_bomb' ||
                    d.kind === 'deck_gun_hit',
                );
                if (!alertEvents.length) return null;
                return (
                <div className="controls-bridge-dc-alert" role="status" aria-live="assertive">
                  <span className="controls-bridge-dc-alert-key">BRIDGE</span>
                  <span className="readout">
                    {(() => {
                      const events = alertEvents;
                      const hits = events.filter(
                        (d) => d.kind === 'torpedo_hit' || d.kind === 'aircraft_bomb',
                      ).length;
                      const bombs = events.filter((d) => d.kind === 'aircraft_bomb').length;
                      const dcs = events.filter((d) => d.kind === 'depth_charge').length;
                      const parts: string[] = [];
                      if (hits > 0 && bombs === hits) {
                        parts.push(`BOMB ×${bombs}`);
                      } else if (hits > 0) {
                        parts.push(
                          bombs > 0
                            ? `HIT ×${hits - bombs} · BOMB ×${bombs}`
                            : `TORPEDO HIT ×${hits}`,
                        );
                      }
                      if (dcs > 0) {
                        parts.push(
                          `DEPTH CHARGE ×${dcs} within ~${Math.max(
                            ...events.filter((d) => d.kind === 'depth_charge').map((d) => d.rangeNm),
                          ).toFixed(2)} nm`,
                        );
                      }
                      return parts.join(' · ') || 'Weapon blast';
                    })()}
                  </span>
                </div>
                );
              })()}
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
                {expectedMove && (
                  <MoveDistanceReadout
                    distanceNm={expectedMove.distanceNm}
                    speedKn={expectedMove.speedKn}
                    turnLengthSeconds={vessel.turnLengthSeconds}
                  />
                )}
                <div className="controls-status-item">
                  <span className="controls-status-key">Engine orders</span>
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
                  <span className="readout">
                    {orderWritePending ? '… ' : ''}
                    {formatPendingOrdersSummary(displayOrders)}
                  </span>
                </div>
              </div>
            </section>

            <div className="sensor-tabs" role="tablist" aria-label="Controls instruments">
              {controlsTabs.map((tab) => {
                if (tab.id === 'eot' && !canEot) return null;
                if (tab.id === 'dive' && !(canHelm && vessel.unit.type === 'Submarine')) {
                  return null;
                }
                if (tab.id === 'torpedoes' && !canTorpedo) return null;
                if (tab.id === 'guns' && !canDeckGun) return null;
                if (tab.id === 'depth_charges' && !canDepthCharges) return null;
                if (tab.id === 'countermeasures' && !canCountermeasures) return null;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className={controlsTab === tab.id ? 'primary' : undefined}
                    aria-selected={controlsTab === tab.id}
                    onClick={() => setControlsTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {controlsTab === 'helm' && (
              <section className="panel stack controls-helm-panel station-instrument-panel">
                <div className="station-instrument-head">
                  {guideHelm ? (
                    <StationInstrumentTitle title="Helm" guideId={guideHelm} />
                  ) : (
                    <h2>Helm</h2>
                  )}
                </div>
                {canHelm && (
                  <HelmCompass
                    heading={vessel.unit.heading}
                    orderedCourse={vessel.unit.orderedCourse}
                    draftCourse={course}
                    onDraftCourseChange={setCourse}
                    disabled={
                      !vessel.canSubmitOrders ||
                      presentationSubs.steering === 'stuck' ||
                      presentationSubs.steering === 'disabled'
                    }
                    turnRate={vessel.unit.turnRate}
                  >
                    {(presentationSubs.steering === 'stuck' ||
                      presentationSubs.steering === 'disabled') && (
                      <p className="dive-risk dive-risk--warn" role="status">
                        {presentationSubs.steering === 'stuck'
                          ? 'Rudder stuck — course orders blocked until repaired.'
                          : 'Steering disabled — course orders blocked until repaired.'}
                      </p>
                    )}
                    <CrtTrainControl
                      label={`Steer · hold · ${COURSE_NUDGE_DEG}°`}
                      onNudge={(dir) =>
                        setCourse((prev) =>
                          normalizeHeading(Math.round(prev) + dir * COURSE_NUDGE_DEG),
                        )
                      }
                      decreaseLabel={`Steer course ${COURSE_NUDGE_DEG} degree to port. Hold to repeat.`}
                      increaseLabel={`Steer course ${COURSE_NUDGE_DEG} degree to starboard. Hold to repeat.`}
                      disabled={
                        !vessel.canSubmitOrders ||
                        presentationSubs.steering === 'stuck' ||
                        presentationSubs.steering === 'disabled'
                      }
                    />
                    <div className="control-actions">
                      <button
                        className={[
                          'primary',
                          orderWritePending && displayOrders.course !== undefined
                            ? 'is-pending'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        type="button"
                        disabled={
                          !vessel.canSubmitOrders ||
                          presentationSubs.steering === 'stuck' ||
                          presentationSubs.steering === 'disabled'
                        }
                        aria-busy={
                          (orderWritePending && displayOrders.course !== undefined) ||
                          undefined
                        }
                        onClick={() => void submit({ course })}
                      >
                        {orderWritePending && displayOrders.course !== undefined
                          ? 'Submitting…'
                          : 'Submit course'}
                      </button>
                    </div>
                  </HelmCompass>
                )}
              </section>
            )}

            {controlsTab === 'dive' && canHelm && vessel.unit.type === 'Submarine' && (
              <section className="panel stack controls-dive-panel station-instrument-panel">
                <div className="station-instrument-head">
                  {guideDive ? (
                    <StationInstrumentTitle title="Dive plane" guideId={guideDive} />
                  ) : (
                    <h2>Dive plane</h2>
                  )}
                </div>
                <DiveControls
                  depth={displayedKeelDepthM}
                  orderedDepth={vessel.unit.orderedDepth ?? vessel.unit.position.depth}
                  draftDepth={depth}
                  onDraftDepthChange={(d) => setDepth(clampSubmarineDepth(d))}
                  maxDepthM={SUBMARINE_MAX_DEPTH_M}
                  orderStepM={SUBMARINE_DEPTH_ORDER_STEP_M}
                  disabled={!vessel.canSubmitOrders}
                  divePlanesLocked={
                    presentationSubs.divePlanes === 'stuck' ||
                    presentationSubs.divePlanes === 'disabled'
                  }
                  writePending={
                    orderWritePending && displayOrders.depth !== undefined
                  }
                  onSubmit={(d, opts) => {
                    const blow = Boolean(opts?.emergencyBlow);
                    pendingEmergencyBlowRef.current = blow;
                    // Wait for orderedDepth === 0 on the stream before treating
                    // ordered>0 as a cancel (see emergencyBlowOrderSeenRef).
                    emergencyBlowOrderSeenRef.current = false;
                    void submit({
                      depth: clampSubmarineDepth(d),
                      ...(blow ? { emergencyBlow: true } : {}),
                    });
                  }}
                />
              </section>
            )}

            {controlsTab === 'torpedoes' && canTorpedo && (
              <TorpedoCalculator
                ownHeading={vessel.unit.heading}
                orderedCourse={vessel.unit.orderedCourse}
                forward={{
                  ready: vessel.unit.torpedoForward ?? 0,
                  awaitingReload: Boolean(
                    vessel.unit.torpedoForwardAwaitingReload ||
                      reloadOptimistic.torpedoForward,
                  ),
                  reloadTurnsRemaining: vessel.unit.torpedoForwardReloadTurnsRemaining ?? 0,
                }}
                aft={{
                  ready: vessel.unit.torpedoAft ?? 0,
                  awaitingReload: Boolean(
                    vessel.unit.torpedoAftAwaitingReload || reloadOptimistic.torpedoAft,
                  ),
                  reloadTurnsRemaining: vessel.unit.torpedoAftReloadTurnsRemaining ?? 0,
                }}
                pending={displayOrders.fireTorpedo}
                arcBlock={vessel.unit.torpedoArcBlock}
                running={vessel.ownTorpedoes}
                disabled={!vessel.canSubmitOrders}
                reloadBusy={weaponReloadBusy}
                writePending={orderWritePending}
                onSubmit={(fireTorpedo) => void submit({ fireTorpedo })}
                onClear={() => void submit({ fireTorpedo: null })}
                onReload={(room) => void reloadTorpedoRoom(room)}
              />
            )}

            {controlsTab === 'guns' && canDeckGun && (
              <DeckGunControls
                vesselType={vessel.unit.type}
                hullClass={vessel.unit.class}
                keelDepthM={vessel.unit.position.depth}
                deckGunLoad={vessel.unit.deckGunLoad ?? 0}
                awaitingReload={Boolean(
                  vessel.unit.deckGunAwaitingReload || reloadOptimistic.deckGun,
                )}
                reloadTurnsRemaining={vessel.unit.deckGunReloadTurnsRemaining ?? 0}
                pending={displayOrders.fireDeckGun}
                fireBlock={vessel.unit.deckGunFireBlock}
                disabled={!vessel.canSubmitOrders}
                reloadBusy={weaponReloadBusy}
                writePending={orderWritePending}
                opticsContacts={opticsContacts
                  .filter((c) => c.kind !== 'periscope')
                  .map((c) => ({
                    labelN: c.labelN,
                    relativeBearing: c.relativeBearing,
                    rangeNm: c.rangeNm,
                    speedKn: c.speedKn,
                  }))}
                onSubmit={(fireDeckGun) => void submit({ fireDeckGun })}
                onClear={() => void submit({ fireDeckGun: null })}
                onReload={() => void reloadDeckGun()}
              />
            )}

            {controlsTab === 'depth_charges' && canDepthCharges && (
              <DepthChargeControls
                depthChargeLoad={vessel.unit.depthChargeLoad ?? 0}
                awaitingReload={Boolean(
                  vessel.unit.depthChargeAwaitingReload || reloadOptimistic.depthCharges,
                )}
                reloadTurnsRemaining={vessel.unit.depthChargeReloadTurnsRemaining ?? 0}
                pending={displayOrders.dropDepthCharges}
                tracks={vessel.ownDepthCharges}
                disabled={!vessel.canSubmitOrders}
                reloadBusy={weaponReloadBusy}
                writePending={orderWritePending}
                onSubmit={(dropDepthCharges) => void submit({ dropDepthCharges })}
                onClear={() => void submit({ dropDepthCharges: null })}
                onReload={() => void reloadDepthCharges()}
              />
            )}

            {controlsTab === 'countermeasures' && canCountermeasures && (
              <CountermeasuresControls
                keelDepthM={vessel.unit.position.depth}
                cooldownTurnsRemaining={vessel.unit.noisemakerCooldownTurnsRemaining ?? 0}
                pending={displayOrders.deployNoisemaker}
                tracks={vessel.ownNoisemakers}
                disabled={!vessel.canSubmitOrders}
                writePending={orderWritePending}
                onSubmit={(deployNoisemaker) => void submit({ deployNoisemaker })}
                onClear={() => void submit({ deployNoisemaker: null })}
              />
            )}

            {controlsTab === 'damage' && (
              <DamageReportPanel
                vesselName={vessel.unit.name}
                vesselType={vessel.unit.type}
                hullClass={vessel.unit.class}
                health={syncedDamage.health}
                condition={syncedDamage.condition}
                subsystems={syncedDamage.subsystems}
                damageLog={syncedDamage.damageLog}
                gopherTask={vessel.unit.gopherTask}
              />
            )}

            {controlsTab === 'eot' && (
              <>
                {canEot && (
                  <section className="panel stack controls-eot-panel station-instrument-panel">
                    <div className="station-instrument-head">
                      {guideEot ? (
                        <StationInstrumentTitle title="Engine orders" guideId={guideEot} />
                      ) : (
                        <h2>Engine orders</h2>
                      )}
                    </div>
                    {presentationSubs.propulsion === 'disabled' && (
                      <p className="dive-risk dive-risk--warn" role="status">
                        Propulsion disabled — engine orders blocked until repaired.
                      </p>
                    )}
                    <EotTelegraph
                      value={eot}
                      onChange={setEot}
                      disabled={
                        !vessel.canSubmitOrders ||
                        presentationSubs.propulsion === 'disabled'
                      }
                    />
                    <div className="control-actions">
                      <button
                        className={[
                          'primary',
                          orderWritePending && displayOrders.eot !== undefined
                            ? 'is-pending'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        type="button"
                        disabled={
                          !vessel.canSubmitOrders ||
                          presentationSubs.propulsion === 'disabled'
                        }
                        aria-busy={
                          (orderWritePending && displayOrders.eot !== undefined) ||
                          undefined
                        }
                        onClick={() => {
                          // Engine-room confirm ring: only when locking in a real EOT change
                          // (telegraph already dinged on position move). Re-submit of the
                          // standing order is silent — no pointless double ding.
                          const standing = displayOrders.eot ?? vessel.unit.eot;
                          if (eot !== standing) void playEngineOrderBell();
                          void submit({ eot });
                        }}
                      >
                        {orderWritePending && displayOrders.eot !== undefined
                          ? 'Submitting…'
                          : 'Submit engine orders'}
                      </button>
                    </div>
                  </section>
                )}

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
                          {conditionLabel(vessel.unit.type, syncedDamage.condition)}
                        </td>
                      </tr>
                      <tr>
                        <th>Propulsion</th>
                        <td className="readout">{syncedDamage.subsystems.propulsion}</td>
                      </tr>
                      <tr>
                        <th>Steering</th>
                        <td className="readout">{syncedDamage.subsystems.steering}</td>
                      </tr>
                      {vessel.unit.type === 'Submarine' && (
                        <tr>
                          <th>Dive planes</th>
                          <td className="readout">{syncedDamage.subsystems.divePlanes}</td>
                        </tr>
                      )}
                      <tr>
                        <th>Radar</th>
                        <td className="readout">{syncedDamage.subsystems.radar}</td>
                      </tr>
                      {vessel.unit.type === 'Submarine' ? (
                        <>
                          <tr>
                            <th>Hydrophone</th>
                            <td className="readout">{syncedDamage.subsystems.hydrophone}</td>
                          </tr>
                          <tr>
                            <th>Periscope</th>
                            <td className="readout">{syncedDamage.subsystems.lookout}</td>
                          </tr>
                        </>
                      ) : (
                        <tr>
                          <th>Active sonar</th>
                          <td className="readout">{syncedDamage.subsystems.activeSonar}</td>
                        </tr>
                      )}
                      {vessel.unit.type === 'Submarine' && (
                        <tr>
                          <th>Depth</th>
                          <td className="readout">{formatCoarseDepthMeters(vessel.unit.position.depth)}</td>
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

            {/* Turn status under the instrument — same placement as Sensors */}

            <section className="panel stack station-turn-panel">
              <h2>Turn</h2>
              {hasPendingOrders(displayOrders) ? (
                <div className="orders-of-record" role="status">
                  <span
                    className={`status-pill ${
                      orderWritePending || ordersOverlay ? 'pending' : 'open'
                    }`}
                  >
                    {orderWritePending || ordersOverlay ? 'Updating…' : 'Submitted'}
                  </span>
                  <span className="mono readout">
                    {formatPendingOrdersSummary(displayOrders)}
                  </span>
                  {displayOrders.updatedByStationId && (
                    <span className="mono muted">via {displayOrders.updatedByStationId}</span>
                  )}
                </div>
              ) : (
                <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
                  No pending orders.
                </p>
              )}
              <div className="control-actions continue-standing-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!vessel.canSubmitOrders || !continueStandingOrdersPatch}
                  title="Re-file standing helm / engine orders / dive for this turn"
                  onClick={continueStandingOrders}
                >
                  Continue standing orders
                </button>
              </div>
              {!vessel.canSubmitOrders && (
                <p className="muted" style={{ margin: 0 }}>
                  Ordering closed.
                </p>
              )}
              {vessel.stationConnections.some((c) => c.count > 1) && (
                <p className="mono" style={{ margin: 0, color: 'var(--accent-strong)' }}>
                  Multi-connection —{' '}
                  {vessel.stationConnections
                    .filter((c) => c.count > 0)
                    .map((c) => `${c.stationId}×${c.count}`)
                    .join(', ')}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
    </CrtShell>
  );
}
