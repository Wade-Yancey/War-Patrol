import { SCHEMA_VERSION } from './constants.js';

export type SideId = string;

/** Allegiance / force identity (umpire + own-ship; not leaked via FoW sensors). */
export type Faction = 'Red' | 'Blue' | 'Civilian';

/** High-level platform category (Submarine | Ship | Aircraft). */
export type VesselType = 'Submarine' | 'Ship' | 'Aircraft';

/**
 * Taxonomic hull / airframe class.
 * Must stay consistent with {@link VesselType} (e.g. Fleet Submarine → Submarine).
 */
export type HullClass =
  | 'Fleet Submarine'
  | 'Destroyer'
  | 'Cruiser'
  | 'Aircraft Carrier'
  | 'Merchant'
  | 'Oiler'
  | 'Battleship'
  | 'Fighter'
  | 'Bomber';

/** Aircraft elevation band (no free altitude number). */
export type FlightLevel = 'low' | 'medium' | 'high';

/**
 * Hull / airframe condition.
 * `sunk` = sunk for ships/subs, destroyed for aircraft — unit stops contributing.
 */
export type UnitCondition = 'afloat' | 'sunk';

/** Major subsystem health (umpire-editable). */
export type SubsystemState = 'intact' | 'disabled';

export interface UnitSubsystems {
  propulsion: SubsystemState;
  sensors: SubsystemState;
}

/** Relative radar cross-section / echo size (detection stub). */
export type RadarSignature = 'small' | 'medium' | 'large';

/** Installed sensor kinds (equipment — distinct from station capability tags). */
export type SensorKind = 'radar' | 'hydrophone' | 'active_sonar' | 'lookout';

/** Shipboard sensor installation (class/unit data). */
export interface SensorDef {
  kind: SensorKind;
  /** Max useful range in nm (radar / hydrophone stub). */
  maxRangeNm?: number;
}

export type StationCapability =
  | 'helm'
  | 'engineering'
  | 'lookout'
  | 'hydrophone'
  | 'radar'
  | 'active_sonar'
  | 'weapons'
  | 'torpedo'
  | 'comms'
  | 'plot';

/** Engine Order Telegraph settings (ARCH-EOT minimal). */
export type EotSetting =
  | 'stop'
  | 'ahead_1'
  | 'ahead_2'
  | 'ahead_3'
  | 'ahead_standard'
  | 'ahead_full'
  | 'ahead_flank'
  | 'back_1'
  | 'back_2'
  | 'back_full';

export type TurnPhase = 'open' | 'locked' | 'awaiting_resolution';

export interface LatLonDepth {
  lat: number;
  lon: number;
  /** Depth in meters (positive down). Surface = 0. */
  depth: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface StationDef {
  id: string;
  name: string;
  capabilities: StationCapability[];
}

/** Depth-charge drop pattern (destroyer rack / thrower stub). */
export type DepthChargePattern = 'single' | 'pair' | 'pattern_3' | 'pattern_5';

/** Pending torpedo shot for the current turn (fleet sub Controls). */
export interface TorpedoFireOrder {
  /**
   * Player LOS / aim bearing to the estimated present target (true °).
   * Combined with course/speed/range on resolve to compute the intercept
   * fire heading — never auto-filled from sim truth.
   */
  aimHeading: number;
  /**
   * Player-entered estimated target true course (degrees).
   * Drives intercept lead with speed/range — never auto-filled from sim heading.
   */
  estimatedCourse: number;
  /**
   * Player-entered target speed estimate (knots).
   * Drives intercept lead with course/range — never auto-filled from sim speed.
   */
  estimatedSpeedKn: number;
  /**
   * Player-entered estimated range to target (nautical miles).
   * Places the estimated present position along aim — never auto-filled from sim range.
   */
  estimatedRangeNm: number;
  /**
   * Number of fish in the spread (1 = single shot). Consumes that many from load.
   * Omitted → 1. Clamped to available tubes / load on resolve.
   */
  spreadCount?: number;
  /**
   * Angular spacing between adjacent fish (degrees). Centered on the
   * solution-derived fire heading. Ignored when spreadCount === 1.
   * Omitted → default interval.
   */
  spreadDeg?: number;
}

/** Pending depth-charge drop for the current turn (destroyer Controls). */
export interface DepthChargeDropOrder {
  pattern: DepthChargePattern;
  /** Detonation depth setting meters (positive down). */
  depthSettingM: number;
}

export interface UnitOrders {
  /** Desired course in degrees true (0–360). */
  course?: number;
  /** Desired EOT setting. */
  eot?: EotSetting;
  /**
   * Desired depth in meters (positive down). Submarines only.
   * Applied to {@link UnitState.position}.depth on turn resolve.
   */
  depth?: number;
  /** Fire a torpedo / spread this resolve (consumes load on launch). */
  fireTorpedo?: TorpedoFireOrder;
  /** Drop a depth-charge pattern this resolve (consumes rack load). */
  dropDepthCharges?: DepthChargeDropOrder;
  updatedAt?: string;
  updatedByStationId?: string;
}

/** Running / spent steam torpedo (Mk 14–ish). */
export type TorpedoStatus = 'running' | 'hit' | 'expired' | 'duded';

export interface TorpedoTrack {
  id: string;
  firerUnitId: string;
  /** Launch / drop origin (fixed) — umpire GT trail start. */
  launchPosition: LatLonDepth;
  position: LatLonDepth;
  /** Run heading degrees true. */
  heading: number;
  /** Speed knots (constant for v1). */
  speedKn: number;
  /** Remaining run distance in nautical miles. */
  remainingRunNm: number;
  /** Ordered run depth (m) — sim-fixed default; not player-ordered in v1. */
  runDepthM: number;
  launchedTurn: number;
  status: TorpedoStatus;
  /** Target unit id when status === hit. */
  hitUnitId?: string;
  /**
   * Snapshotted calculator estimates at launch (of-record).
   * At fire time these drove the intercept fire heading; hit resolution
   * itself is pure geometry against truth kinematics.
   */
  estimatedCourse: number;
  estimatedSpeedKn: number;
  estimatedRangeNm: number;
  /**
   * Breadcrumb positions along the run (launch → current/end).
   * Umpire GT map polyline; includes launch as first point.
   */
  path: Array<{ lat: number; lon: number }>;
}

export type DepthChargeStatus = 'sinking' | 'detonated' | 'spent';

/** Sinking / detonated depth charge. */
export interface DepthChargeTrack {
  id: string;
  firerUnitId: string;
  /** Surface drop origin (fixed) — umpire GT trail start. */
  launchPosition: LatLonDepth;
  position: LatLonDepth;
  /** Operator depth setting (m) — detonates when keel depth reaches this. */
  depthSettingM: number;
  sinkRateMps: number;
  status: DepthChargeStatus;
  launchedTurn: number;
  pattern: DepthChargePattern;
  detonatedAtDepthM?: number;
  /**
   * Horizontal path is a point (drops in place); we still keep launch + current
   * for GT markers. Depth progress is labeled on the end pip.
   */
  path: Array<{ lat: number; lon: number; depth: number }>;
}

/** Recent weapon blast (audio + umpire truth). Cleared after a few turns. */
export interface WeaponDetonationEvent {
  id: string;
  kind: 'depth_charge' | 'torpedo_hit';
  position: LatLonDepth;
  turnNumber: number;
  firerUnitId: string;
  /** Hit target for torpedo_hit — firer and target both get Controls audio cues. */
  targetUnitId?: string;
}

/**
 * Lookout / periscope FoW cue — torpedo wake direction only (not identity).
 * Relative bearing of apparent wake travel vs own heading.
 */
export interface TorpedoWakeCue {
  id: string;
  /**
   * Relative bearing of wake travel direction (−180, 180], coarsened.
   * Bow = 0; starboard positive.
   */
  relativeBearing: number;
  /** Operator confidence — never a sure ID. */
  confidence: 'possible' | 'likely';
}

export interface UnitState {
  id: string;
  name: string;
  /**
   * Legacy side id (lowercase blue/red/civilian). Kept in sync with {@link faction}
   * for older clients and stripe CSS hooks.
   */
  side: SideId;
  /** Force allegiance: Red | Blue | Civilian. */
  faction: Faction;
  /** Library definition id (e.g. fletcher-class). */
  classId: string;
  /** Platform category: Submarine | Ship | Aircraft. */
  type: VesselType;
  /** Hull / airframe class (Destroyer, Fleet Submarine, …). */
  class: HullClass;
  position: LatLonDepth;
  /**
   * Aircraft elevation band only (Ship/Submarine ignore).
   * Defaults to `medium` for Aircraft; omitted or ignored otherwise.
   */
  flightLevel?: FlightLevel;
  /** Afloat vs sunk/destroyed. Defaults afloat. */
  condition: UnitCondition;
  /** Propulsion + sensors integrity. Defaults intact. */
  subsystems: UnitSubsystems;
  /** Current heading degrees true (bow direction). */
  heading: number;
  /**
   * Ordered / steering course degrees true (helm set-point).
   * Ship turns toward this over resolves; persists across turns.
   */
  orderedCourse: number;
  /**
   * Ordered depth meters (positive down) — submarine standing set-point.
   * Ringed up immediately on Controls submit; actual {@link position}.depth
   * approaches this on each resolve at the fleet-boat dive/ascent rate
   * (`SUBMARINE_DEPTH_RATE_M_PER_MIN`). Ships/aircraft always 0.
   */
  orderedDepth: number;
  /** Speed in knots (signed: negative = reverse). */
  speed: number;
  /** Current acknowledged EOT setting. */
  eot: EotSetting;
  /** Access token embedded in vessel join URLs. */
  accessToken: string;
  /** Optional vessel password (plain for Phase 1 local demo). */
  password?: string;
  stations: StationDef[];
  /** Health placeholder 0–100 (ARCH-UC). */
  health: number;
  /** In-progress orders for current turn (cleared on resolve/rollback). */
  orders: UnitOrders;
  /** Max speed knots for class (from library stub or class enum default). */
  maxSpeed: number;
  /**
   * Overall length in meters (sim / collision — not shown on player stations).
   * From library stub or taxonomic class default.
   */
  lengthM: number;
  /**
   * Beam (ships/subs) or wingspan (aircraft) in meters — sim / collision only.
   * From library stub or taxonomic class default.
   */
  beamM: number;
  /**
   * Steady turn rate deg per in-game minute.
   * Derived from radarSignature (size) unless scenario overrides.
   */
  turnRate: number;
  /** Radar echo size / hull-size proxy (small|medium|large). */
  radarSignature: RadarSignature;
  /** Installed sensors (destroyers and subs include radar for play). */
  sensors: SensorDef[];
  /**
   * Destroyer active search sonar operator toggle (immediate, not turn-order).
   * When true and the set is installed/healthy, the unit pings and paints a forward-cone picture.
   */
  activeSonarEnabled: boolean;
  /**
   * Fleet-sub periscope mast toggle (immediate, Sensors station).
   * When false the boat is optically blind even at periscope depth.
   * Surface ships ignore this field (bridge lookout has no mast).
   */
  periscopeRaised: boolean;
  /**
   * Fraction of the turn the mast is exposed while raised (0–1).
   * Immediate Sensors control — player choice for how long the mast stays up.
   * Any exposure &gt; 0 makes the feather visible to DD lookout in range
   * (deterministic FoW; no spot roll). Forced to 0 when the mast is down.
   * Surface ships ignore this field.
   */
  periscopeExposure: number;
  /**
   * Consecutive resolved turns the periscope stayed up with a held visual contact.
   * Resets to 0 whenever the scope is lowered (no frozen plot bonus).
   * v1: stamp is tracked for FoW / future solution quality — geometry hits do not
   * yet apply a plot-quality damage/hit bonus.
   */
  plotStampTurns: number;
  /**
   * Ready torpedoes remaining (fleet subs). 0 for non-torpedo hulls.
   * Consumed when a fire order launches on resolve.
   */
  torpedoLoad: number;
  /**
   * Ready depth charges remaining (destroyers). 0 for non-DC hulls.
   * Consumed when a drop pattern launches on resolve.
   */
  depthChargeLoad: number;
}

export interface ScenarioUnitSeed {
  id: string;
  name: string;
  /** Legacy side id; used to migrate faction when faction omitted. */
  side: SideId;
  /** Force allegiance; optional on older scenarios — migrated from side. */
  faction?: Faction;
  classId: string;
  /** Platform category; legacy destroyer|submarine|… values are migrated on load. */
  type: VesselType | string;
  /** Hull class; optional on older scenarios — filled by migration. */
  class?: HullClass;
  position: LatLonDepth;
  /** Aircraft only — low | medium | high. */
  flightLevel?: FlightLevel;
  condition?: UnitCondition;
  subsystems?: Partial<UnitSubsystems>;
  heading: number;
  /** Initial ordered course; defaults to heading. */
  orderedCourse?: number;
  /** Initial ordered depth (m); defaults to position.depth for submarines. */
  orderedDepth?: number;
  speed: number;
  eot?: EotSetting;
  accessToken: string;
  password?: string;
  stations: StationDef[];
  health?: number;
  maxSpeed?: number;
  /** Overall length meters; omit to inherit taxonomic / library default. */
  lengthM?: number;
  /** Beam (or aircraft wingspan) meters; omit to inherit class default. */
  beamM?: number;
  /** Explicit deg/min override; else from radarSignature size. */
  turnRate?: number;
  radarSignature?: RadarSignature;
  sensors?: SensorDef[];
  /** Optional seed for destroyer active sonar toggle (default false). */
  activeSonarEnabled?: boolean;
  /** Optional seed for fleet-sub periscope raised (default false). */
  periscopeRaised?: boolean;
  /** Optional seed for mast exposure fraction 0–1 while raised (default 1 when raised). */
  periscopeExposure?: number;
  /** Optional seed for plot stamp turns (default 0). */
  plotStampTurns?: number;
  /** Optional ready torpedo count (fleet subs). */
  torpedoLoad?: number;
  /** Optional ready depth-charge count (destroyers). */
  depthChargeLoad?: number;
}

export interface Scenario {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  mode: 'pvp' | 'pve';
  operatingArea: BoundingBox;
  umpirePassword?: string;
  /** Wall-clock ordering-phase duration (seconds). */
  defaultTurnSeconds: number;
  /**
   * In-game seconds advanced per resolved turn (default 180 = 3 min).
   * Used for movement kinematics and the scenario clock.
   */
  turnLengthSeconds?: number;
  /** In-game clock at turn 1 (seconds since midnight; default 08:00). */
  startGameTimeSeconds?: number;
  units: ScenarioUnitSeed[];
}

export interface TurnState {
  number: number;
  phase: TurnPhase;
  /** ISO deadline when timer is running; null if no timer. */
  timerDeadline: string | null;
  /** Configured duration in seconds for the current / next open phase. */
  timerSeconds: number;
  /**
   * In-game clock (seconds since midnight, may exceed 86400 if multi-day).
   * Advances by save.turnLengthSeconds on each resolve.
   */
  gameTimeSeconds: number;
}

export interface TurnSnapshot {
  turnNumber: number;
  resolvedAt: string;
  stateVersion: number;
  units: UnitState[];
  turn: TurnState;
  /** In-game clock after this resolve (mirrors turn.gameTimeSeconds). */
  gameTimeSeconds: number;
}

/** Lightweight lat/lon breadcrumb for umpire trails. */
export interface TrailPoint {
  lat: number;
  lon: number;
  /** Turn number when this position was the unit's post-resolve state (0 = scenario start). */
  turnNumber: number;
}

export interface UnitTrail {
  unitId: string;
  points: TrailPoint[];
}

export interface GameSave {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  scenarioId: string;
  scenarioName: string;
  mode: 'pvp' | 'pve';
  operatingArea: BoundingBox;
  umpirePassword?: string;
  createdAt: string;
  updatedAt: string;
  stateVersion: number;
  turn: TurnState;
  /** In-game seconds advanced per resolved turn. */
  turnLengthSeconds: number;
  /**
   * Scenario-start positions for umpire trails (turn 0 breadcrumbs).
   * History snapshots alone are post-resolve and would omit the origin.
   */
  startTrails: UnitTrail[];
  units: UnitState[];
  history: TurnSnapshot[];
  /** In-flight / sinking weapons (umpire ground truth + resolve tracking). */
  torpedoes: TorpedoTrack[];
  depthCharges: DepthChargeTrack[];
  /** Recent depth-charge detonations for hydrophone / Controls audio FoW.
   * Pruned after a few turns.
   */
  recentDetonations: WeaponDetonationEvent[];
  /**
   * Chronological umpire-only action / damage log (weapon launches, hits, DCs, …).
   * Appended on resolve; not included in vessel FoW views.
   */
  combatLog: CombatLogEntry[];
}

/** Kinds of umpire combat / action log lines. */
export type CombatLogKind =
  | 'torpedo_launch'
  | 'torpedo_hit'
  | 'torpedo_expired'
  | 'depth_charge_drop'
  | 'depth_charge_detonation'
  | 'depth_charge_damage'
  | 'unit_sunk'
  | 'subsystem_casualty';

/** One umpire-visible action / damage line (CRT log). */
export interface CombatLogEntry {
  id: string;
  kind: CombatLogKind;
  /** Turn number when the event was resolved. */
  turnNumber: number;
  /** In-game clock after that resolve (seconds since midnight). */
  gameTimeSeconds: number;
  /** Wall-clock ISO when logged. */
  at: string;
  /** Compact CRT summary (no secrets beyond GT). */
  summary: string;
  actorUnitId?: string;
  actorName?: string;
  targetUnitId?: string;
  targetName?: string;
  /** Hit points applied when relevant. */
  damage?: number;
}

/**
 * Own-ship FoW damage line for Controls Damage report.
 * Never includes enemy full damage board — only events targeting this hull.
 */
export interface OwnDamageEvent {
  id: string;
  kind: Extract<
    CombatLogKind,
    'torpedo_hit' | 'depth_charge_damage' | 'unit_sunk' | 'subsystem_casualty'
  >;
  turnNumber: number;
  gameTimeSeconds: number;
  /** Operator-facing summary (no enemy GT beyond what own crew knows). */
  summary: string;
  damage?: number;
}

/** Vessel-class library stub (ARCH-LIB data shape only). */
export interface VesselClassStub {
  id: string;
  name: string;
  /** Platform category: Submarine | Ship | Aircraft. */
  type: VesselType;
  /** Hull / airframe class for this library entry. */
  class: HullClass;
  /**
   * Optional default faction for new units of this class
   * (e.g. Merchant/Oiler → Civilian).
   */
  defaultFaction?: Faction;
  /** Max speed knots (historical approximation for the concrete hull). */
  maxSpeed: number;
  /** Overall length meters (historical approximation for the concrete hull). */
  lengthM: number;
  /**
   * Beam meters for ships/subs; wingspan meters for aircraft.
   * Historical approximation for collision / combat stubs.
   */
  beamM: number;
  /** Steady turn rate deg per in-game minute. */
  turnRate: number;
  /** Default radar echo size for ships of this class. */
  radarSignature: RadarSignature;
  /** Default installed sensors for the class. */
  sensors?: SensorDef[];
  defaultStations: StationDef[];
}

/** Monotonic push envelope (ARCH-SA-07). */
export interface StatePushEnvelope<TView> {
  type: 'state';
  stateVersion: number;
  view: TView;
}

export interface ConnectionInfo {
  stationId?: string;
  role: 'umpire' | 'vessel';
  unitId?: string;
}

/** Umpire ground-truth view. */
export interface UmpireView {
  role: 'umpire';
  gameId: string;
  name: string;
  scenarioId: string;
  scenarioName: string;
  mode: 'pvp' | 'pve';
  operatingArea: BoundingBox;
  stateVersion: number;
  turn: TurnState;
  turnLengthSeconds: number;
  units: UnitState[];
  /** Prior-turn position trails per unit (history + current). */
  trails: UnitTrail[];
  /** Full-truth weapon tracks (running fish + sinking/detonated charges). */
  torpedoes: TorpedoTrack[];
  depthCharges: DepthChargeTrack[];
  recentDetonations: WeaponDetonationEvent[];
  /** Chronological action / damage log (umpire only). */
  combatLog: CombatLogEntry[];
  historyTurnNumbers: number[];
  vesselLinks: Array<{
    unitId: string;
    name: string;
    accessToken: string;
    passwordProtected: boolean;
    /**
     * True when this hull is a v1 player vessel (Destroyer / Fleet Submarine).
     * Non-player units may appear for umpire/NPC but have empty station join lists.
     */
    playerVessel: boolean;
    stations: Array<{ stationId: string; name: string; path: string }>;
  }>;
  connections: Array<{
    unitId: string | null;
    stationId: string | null;
    role: 'umpire' | 'vessel';
    count: number;
  }>;
}

/**
 * Server-filtered radar contact (ARCH-SP-05 / ARCH-DET).
 * Polar only — never other units' absolute lat/lon or identity.
 */
export interface RadarContact {
  /** Opaque track id (stable while held). */
  id: string;
  /** True bearing degrees (0–360). */
  bearing: number;
  /** Slant/surface range in nautical miles. */
  rangeNm: number;
  /** Relative echo strength 0–1 (stub). */
  strength: number;
  /**
   * Apparent echo size (raw sensor attribute).
   * Not a class/side/name — operators see only small/medium/large.
   */
  signature: RadarSignature;
}

/** Filtered vessel/station view — never other units' ground truth. */
export interface VesselView {
  role: 'vessel';
  gameId: string;
  name: string;
  stateVersion: number;
  turn: TurnState;
  turnLengthSeconds: number;
  unit: Pick<
    UnitState,
    | 'id'
    | 'name'
    | 'side'
    | 'faction'
    | 'type'
    | 'class'
    | 'position'
    | 'flightLevel'
    | 'condition'
    | 'subsystems'
    | 'heading'
    | 'orderedCourse'
    | 'orderedDepth'
    | 'speed'
    | 'eot'
    | 'orders'
    | 'health'
    | 'maxSpeed'
    | 'turnRate'
    | 'radarSignature'
    | 'stations'
    | 'activeSonarEnabled'
    | 'periscopeRaised'
    | 'periscopeExposure'
    | 'plotStampTurns'
    | 'torpedoLoad'
    | 'depthChargeLoad'
  >;
  stationId: string;
  station: StationDef;
  /** Other stations on own vessel with connection counts (multi-connect indicator). */
  stationConnections: Array<{ stationId: string; count: number }>;
  canSubmitOrders: boolean;
  /**
   * Own-side weapon tracks only (fired by this hull) — FoW vs umpire full truth.
   * Running fish / sinking charges the crew launched; never enemy weapons.
   */
  ownTorpedoes?: TorpedoTrack[];
  ownDepthCharges?: DepthChargeTrack[];
  /**
   * Lookout / periscope FoW — possible torpedo wake directions (not identity).
   * Only on stations with `lookout` capability.
   */
  torpedoWakeCues?: TorpedoWakeCue[];
  /**
   * Weapon blasts audible on Controls (close DC, or torpedo hit for firer/target).
   * Polar only — range for gain attenuation; no firer identity in FoW fields.
   */
  bridgeDetonations?: Array<{
    id: string;
    bearing: number;
    rangeNm: number;
    kind: 'depth_charge' | 'torpedo_hit';
  }>;
  /**
   * Radar picture for stations with the `radar` capability.
   * Omitted for non-radar stations — never full unit list.
   */
  radarContacts?: RadarContact[];
  /** Configured max radar range for the scope rings (nm). */
  radarMaxRangeNm?: number;
  /** False when radar set cannot emit (e.g. submarine submerged). */
  radarOperational?: boolean;
  /** Operator-facing reason when radarOperational is false. */
  radarUnavailableReason?: 'submerged' | 'no_sensor' | 'sunk' | 'sensors_disabled';
  /**
   * Passive hydrophone audio cues for stations with the `hydrophone` capability.
   * Ground-truth bearing/range for underway contacts — audio only, never drawn as blips.
   * Omitted for non-hydrophone stations.
   */
  hydrophoneContacts?: HydrophoneContact[];
  /** Configured max hydrophone hearing range (nm). */
  hydrophoneMaxRangeNm?: number;
  /** False when hydrophone cannot listen (sunk / sensors disabled / no set / surfaced sub). */
  hydrophoneOperational?: boolean;
  /** Operator-facing reason when hydrophoneOperational is false. */
  hydrophoneUnavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'surfaced';
  /**
   * Active search sonar picture for stations with the `active_sonar` capability.
   * Forward cone only — omitted for non-sonar stations.
   */
  sonarContacts?: RadarContact[];
  /** Configured max active-sonar range (nm). */
  sonarMaxRangeNm?: number;
  /** Cone half-angle about own heading (degrees). */
  sonarHalfAngleDeg?: number;
  /**
   * True when the set can paint (installed, healthy, and operator toggle ON).
   * When toggle is OFF, operational is false with reason `sonar_off`.
   */
  sonarOperational?: boolean;
  /** Operator-facing reason when sonarOperational is false. */
  sonarUnavailableReason?:
    | 'no_sensor'
    | 'sunk'
    | 'sensors_disabled'
    | 'sonar_off';
  /**
   * Periscope / lookout visual contacts for stations with the `lookout` capability.
   * Relative bearing + coarsened range/speed + silhouette class — no names/sides.
   * Omitted for non-lookout stations.
   */
  periscopeContacts?: PeriscopeContact[];
  /** Configured max periscope visual range (nm). */
  periscopeMaxRangeNm?: number;
  /** False when optics cannot see (too deep / scope down / sunk / sensors disabled / no set). */
  periscopeOperational?: boolean;
  /** Operator-facing reason when periscopeOperational is false. */
  periscopeUnavailableReason?:
    | 'no_sensor'
    | 'sunk'
    | 'sensors_disabled'
    | 'too_deep'
    | 'scope_down';
  /**
   * Own-ship damage events (hits / casualties on this hull only).
   * Controls Damage report — FoW; never the enemy damage board.
   */
  ownDamageLog?: OwnDamageEvent[];
}

/**
 * Anonymous hydrophone contact — polar cue for audio mixing only.
 * No side/class/name; not a visual PPI track.
 */
export interface HydrophoneContact {
  id: string;
  /** True bearing to contact, degrees (0–360). */
  bearing: number;
  /** Slant-plane range in nautical miles (equirectangular). */
  rangeNm: number;
  /**
   * Emitter class for audio mixing:
   * - `propeller` — continuous underwater noise from an underway hull
   * - `active_sonar_ping` — intermittent ping from a destroyer with search sonar ON
   * - `depth_charge` — one-shot detonation cue (recent DC explosion in hearing range)
   */
  kind: 'propeller' | 'active_sonar_ping' | 'depth_charge';
}

/**
 * Periscope / lookout visual contact — silhouette + coarsened readouts only.
 * `silhouetteClass` selects the side-profile asset (identity implied by image only).
 * `kind: 'periscope'` is a DD lookout feather/stick sighting — not a full sub ID.
 */
export interface PeriscopeContact {
  id: string;
  /**
   * `hull` = normal surface silhouette contact.
   * `periscope` = destroyer lookout spotted a raised periscope mast (FoW feather).
   */
  kind?: 'hull' | 'periscope';
  /**
   * Relative bearing degrees (−180, 180], coarsened (e.g. 5° steps).
   * Bow = 0; starboard positive; port negative.
   */
  relativeBearing: number;
  /** Approximate range in nautical miles (coarsened). */
  rangeNm: number;
  /** Approximate absolute speed in knots (coarsened). Always 0 for periscope feathers. */
  speedKn: number;
  /**
   * Hull class for silhouette mapping only
   * (Destroyer → destroyer.png, Fleet Submarine → submarine.png).
   * Not a side/name; other classes fall back to the destroyer plate.
   * Periscope feathers (`kind: 'periscope'`) use a stick/feather SVG in the
   * optics viewer, not a hull plate — `silhouetteClass` is FoW metadata only.
   */
  silhouetteClass: HullClass;
}

export type ClientView = UmpireView | VesselView;

export interface AuthSession {
  token: string;
  gameId: string;
  role: 'umpire' | 'vessel';
  unitId?: string;
  stationId?: string;
  createdAt: string;
}
