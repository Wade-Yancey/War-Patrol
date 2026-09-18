import { SCHEMA_VERSION } from './constants.js';

export type SideId = string;

export type VesselType = 'destroyer' | 'submarine' | 'cruiser' | 'merchant' | 'other';

/** Relative radar cross-section / echo size (detection stub). */
export type RadarSignature = 'small' | 'medium' | 'large';

/** Installed sensor kinds (equipment — distinct from station capability tags). */
export type SensorKind = 'radar' | 'hydrophone' | 'active_sonar' | 'lookout';

/** Shipboard sensor installation (class/unit data). */
export interface SensorDef {
  kind: SensorKind;
  /** Max useful range in nm (radar stub). */
  maxRangeNm?: number;
}

export type StationCapability =
  | 'helm'
  | 'engineering'
  | 'lookout'
  | 'hydrophone'
  | 'radar'
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
  updatedAt?: string;
  updatedByStationId?: string;
}

export interface UnitState {
  id: string;
  name: string;
  side: SideId;
  classId: string;
  type: VesselType;
  position: LatLonDepth;
  /** Heading degrees true. */
  heading: number;
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
  /** Max speed knots for class (from library stub). */
  maxSpeed: number;
  /** Turn rate deg/min stub. */
  turnRate: number;
  /** Radar echo size for detection (class/unit). */
  radarSignature: RadarSignature;
  /** Installed sensors (destroyers include radar per ARCH-STA-03; subs typically do not). */
  sensors: SensorDef[];
}

export interface ScenarioUnitSeed {
  id: string;
  name: string;
  side: SideId;
  classId: string;
  type: VesselType;
  position: LatLonDepth;
  heading: number;
  speed: number;
  eot?: EotSetting;
  accessToken: string;
  password?: string;
  stations: StationDef[];
  health?: number;
  maxSpeed?: number;
  turnRate?: number;
  radarSignature?: RadarSignature;
  sensors?: SensorDef[];
}

export interface Scenario {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  mode: 'pvp' | 'pve';
  operatingArea: BoundingBox;
  umpirePassword?: string;
  defaultTurnSeconds: number;
  units: ScenarioUnitSeed[];
}

export interface TurnState {
  number: number;
  phase: TurnPhase;
  /** ISO deadline when timer is running; null if no timer. */
  timerDeadline: string | null;
  /** Configured duration in seconds for the current / next open phase. */
  timerSeconds: number;
}

export interface TurnSnapshot {
  turnNumber: number;
  resolvedAt: string;
  stateVersion: number;
  units: UnitState[];
  turn: TurnState;
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
  units: UnitState[];
  history: TurnSnapshot[];
}

/** Vessel-class library stub (ARCH-LIB data shape only). */
export interface VesselClassStub {
  id: string;
  name: string;
  type: VesselType;
  maxSpeed: number;
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
  units: UnitState[];
  historyTurnNumbers: number[];
  vesselLinks: Array<{
    unitId: string;
    name: string;
    accessToken: string;
    passwordProtected: boolean;
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
}

/** Filtered vessel/station view — never other units' ground truth. */
export interface VesselView {
  role: 'vessel';
  gameId: string;
  name: string;
  stateVersion: number;
  turn: TurnState;
  unit: Pick<
    UnitState,
    | 'id'
    | 'name'
    | 'side'
    | 'type'
    | 'position'
    | 'heading'
    | 'speed'
    | 'eot'
    | 'orders'
    | 'health'
    | 'maxSpeed'
    | 'stations'
  >;
  stationId: string;
  station: StationDef;
  /** Other stations on own vessel with connection counts (multi-connect indicator). */
  stationConnections: Array<{ stationId: string; count: number }>;
  canSubmitOrders: boolean;
  /**
   * Radar picture for stations with the `radar` capability.
   * Omitted (or empty) for non-radar stations — never full unit list.
   */
  radarContacts?: RadarContact[];
  /** Configured max radar range for the scope rings (nm). */
  radarMaxRangeNm?: number;
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
