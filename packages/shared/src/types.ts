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
  updatedAt?: string;
  updatedByStationId?: string;
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
   * snaps to this on turn resolve (v1 stub — no gradual dive rate yet).
   * Ships/aircraft always 0.
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
  /** Explicit deg/min override; else from radarSignature size. */
  turnRate?: number;
  radarSignature?: RadarSignature;
  sensors?: SensorDef[];
  /** Optional seed for destroyer active sonar toggle (default false). */
  activeSonarEnabled?: boolean;
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
   * In-game seconds advanced per resolved turn (default 300 = 5 min).
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
  >;
  stationId: string;
  station: StationDef;
  /** Other stations on own vessel with connection counts (multi-connect indicator). */
  stationConnections: Array<{ stationId: string; count: number }>;
  canSubmitOrders: boolean;
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
  /** False when optics cannot see (too deep / sunk / sensors disabled / no set). */
  periscopeOperational?: boolean;
  /** Operator-facing reason when periscopeOperational is false. */
  periscopeUnavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'too_deep';
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
   */
  kind: 'propeller' | 'active_sonar_ping';
}

/**
 * Periscope visual contact — silhouette + coarsened readouts only.
 * `silhouetteClass` selects the side-profile asset (identity implied by image only).
 */
export interface PeriscopeContact {
  id: string;
  /**
   * Relative bearing degrees (−180, 180], coarsened (e.g. 5° steps).
   * Bow = 0; starboard positive; port negative.
   */
  relativeBearing: number;
  /** Approximate range in nautical miles (coarsened). */
  rangeNm: number;
  /** Approximate absolute speed in knots (coarsened). */
  speedKn: number;
  /**
   * Hull class for silhouette mapping only (e.g. Destroyer → destroyer.jpg).
   * Not a side/name; other classes may lack assets (CRT placeholder).
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
