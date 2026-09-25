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

/** Binary station / set health (umpire-editable). */
export type SubsystemState = 'intact' | 'disabled';

/** Propulsion: intact, reduced max speed, or dead in the water. */
export type PropulsionState = 'intact' | 'damaged' | 'disabled';

/** Helm / rudder: intact, cannot yaw, or jammed at a fixed ordered course. */
export type SteeringState = 'intact' | 'disabled' | 'stuck';

/** Sub dive planes: intact, jammed at a depth set-point, or disabled. */
export type DivePlanesState = 'intact' | 'stuck' | 'disabled';

/**
 * Combat / umpire subsystem casualties.
 * Sensor stations are independent (radar vs hydrophone vs sonar vs lookout).
 * Legacy saves with only `{ propulsion, sensors }` migrate via `resolveSubsystems`.
 */
export interface UnitSubsystems {
  propulsion: PropulsionState;
  radar: SubsystemState;
  hydrophone: SubsystemState;
  activeSonar: SubsystemState;
  /** Fleet-sub periscope / optics. Ship bridge lookout ignores combat damage. */
  lookout: SubsystemState;
  steering: SteeringState;
  divePlanes: DivePlanesState;
  /** Locked ordered course when {@link steering} === `stuck`. */
  rudderStuckHeading?: number;
  /** Locked ordered depth when dive planes are stuck / disabled. */
  divePlanesStuckDepth?: number;
}

/** Structured combat casualty for umpire log + Controls Damage staging. */
export type CasualtyEffectKind =
  | 'propulsion_damaged'
  | 'propulsion_disabled'
  | 'radar_disabled'
  | 'hydrophone_disabled'
  | 'active_sonar_disabled'
  | 'lookout_disabled'
  | 'steering_disabled'
  | 'rudder_stuck'
  | 'dive_planes_stuck'
  | 'dive_planes_disabled';

export interface CasualtyEffect {
  kind: CasualtyEffectKind;
  stuckHeading?: number;
  stuckDepthM?: number;
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

/** Fleet-sub torpedo room (finite magazine). */
export type TorpedoRoomId = 'forward' | 'aft';

/** Pending torpedo shot for the current turn (fleet sub Controls). */
export interface TorpedoFireOrder {
  /**
   * Which room / tube bank to fire from. Omitted → forward.
   * Consumes fish from that room only; room must not be awaiting / mid reload.
   */
  room?: TorpedoRoomId;
  /**
   * Player LOS / aim bearing to the estimated present target (**true** °).
   * Client UI enters this as optics-style **relative** bearing (bow 0, stbd +,
   * port −) and converts via own heading before submit. Combined with
   * course/speed/range on resolve to compute the intercept fire heading —
   * never auto-filled from sim truth.
   */
  aimHeading: number;
  /**
   * Player-entered estimated target **true course** (degrees) — not angle-on-bow.
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
   * Player-entered estimated target overall length (meters).
   * Look up from the recognition manual (class OA). Scales the geometric hit
   * gate vs true hull length — wrong ID shrinks the intercept chord.
   * Never auto-filled from sim truth.
   */
  estimatedLengthM: number;
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

/**
 * Record of a queued torpedo order that never launched because the hull was
 * outside the room's firing cone at resolve (ordering only validates the
 * heading at queue time — a course change can swing the tubes off target).
 *
 * No fish are expended; the crew is told on the next turn so a lost salvo is
 * never silent. Cleared when a new fire order is queued or a salvo launches.
 */
export interface TorpedoArcBlock {
  /** Turn whose resolve dropped the order. */
  turnNumber: number;
  room: TorpedoRoomId;
  /** Gyro of the solution fire heading vs the room axis at resolve (−180, 180]. */
  gyroDeg: number;
  /** Room cone half-angle the gyro had to stay inside. */
  halfDeg: number;
  /** Own heading at resolve (°) — usually the post-turn heading. */
  ownHeadingDeg: number;
}

/** Pending depth-charge drop for the current turn (destroyer Controls). */
export interface DepthChargeDropOrder {
  pattern: DepthChargePattern;
  /** Detonation depth setting meters (positive down). */
  depthSettingM: number;
}

/**
 * Pending deck-gun salvo for the current turn (destroyer + fleet-sub Controls).
 * Mirror of the torpedo calculator language: aim LOS + estimated course/speed/range
 * drive a same-turn fire solution — never auto-filled from sim truth.
 * `shotCount` is how many rounds to fire this turn (1 shell each; class-capped).
 */
export interface DeckGunFireOrder {
  /**
   * Player LOS / aim bearing to the estimated present target (**true** °).
   * Client UI enters optics-style **relative** bearing and converts via own heading.
   */
  aimHeading: number;
  /** Player-entered estimated target **true course** (degrees). */
  estimatedCourse: number;
  /** Player-entered target speed estimate (knots). */
  estimatedSpeedKn: number;
  /** Player-entered estimated range to target (nautical miles). */
  estimatedRangeNm: number;
  /**
   * Rounds to fire this turn (1 shell each). Clamped to class max shots/turn
   * and ready magazine. Default 1 when omitted (legacy orders).
   */
  shotCount?: number;
}

/**
 * Crew-facing notice when a queued deck-gun order did not fire at resolve
 * (e.g. fleet sub dove before the shot). Cleared on a successful fire or a
 * fresh queue. No ammo expended when blocked.
 */
export interface DeckGunFireBlock {
  turnNumber: number;
  /** Why the shot was dropped. */
  reason: 'submerged';
  /** Keel depth at resolve (m). */
  depthM: number;
}

/** Umpire-ordered aircraft attack run (intercept / gun strafe / bombing). */
export type AircraftAttackMode = 'intercept' | 'strafe' | 'bombing_run';

export interface AircraftAttackOrder {
  mode: AircraftAttackMode;
  /** Target hull id (ship / submarine — never another aircraft). */
  targetUnitId: string;
}

/**
 * Standing NPC aircraft loiter — auto-orbits each resolve without umpire helm.
 * Cleared only by umpire cancel (survives turn order wipe).
 */
export interface AircraftLoiterState {
  /** Geographic orbit center (updated when tracking a parent hull). */
  centerLat: number;
  centerLon: number;
  /** Orbit radius meters. */
  radiusM: number;
  /** Optional parent hull to orbit (e.g. carrier CAP over Shōkaku). */
  centerUnitId?: string;
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
  /** Fire the deck gun this resolve (consumes one shell per shot in the salvo). */
  fireDeckGun?: DeckGunFireOrder;
  /**
   * Umpire aircraft attack run — resolves after kinematics this turn
   * (course toward target + full band usually set with the order).
   */
  aircraftAttack?: AircraftAttackOrder;
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
   * Course/speed/range drove the intercept fire heading; length scales the
   * hit gate vs true hull length on contact.
   */
  estimatedCourse: number;
  estimatedSpeedKn: number;
  estimatedRangeNm: number;
  estimatedLengthM: number;
  /**
   * Best horizontal closest-approach to any eligible hull while running (m),
   * measured track→target center (same geometry as the hit gate miss check).
   * Always the **nearest contact** this run — not the aimed / solution target —
   * so a fish that skimmed Platte at 200 m while Neosho was 6000 m away reports
   * Platte. Accumulated across turns for umpire miss log + AAR GT labels.
   */
  closestApproachM?: number;
  /** Unit id of {@link closestApproachM} (nearest approach this run). */
  closestApproachUnitId?: string;
  /**
   * Display name snapshotted with {@link closestApproachUnitId} (of-record for
   * AAR / GT labels when the live unit list is unavailable).
   */
  closestApproachUnitName?: string;
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

/**
 * Live-museum "gopher task" — umpire free-texts a physical errand
 * ("count the stairs in the forward torpedo room and report over the field
 * phone"); the field telephone call is the verification, not a typed
 * in-app answer. Stored on the unit so it survives reconnects and shows on
 * every station via the persistent cue + in full on Damage.
 */
export type GopherTaskStatus = 'active' | 'completed' | 'cleared';

export interface GopherTask {
  id: string;
  /** Free-text umpire order (e.g. "Count the stairs in the fwd torpedo room"). */
  text: string;
  /** Optional short title shown in the persistent cue (falls back to a clipped text). */
  label?: string;
  status: GopherTaskStatus;
  /** ISO wall-clock when pushed. */
  pushedAt: string;
  /** Turn number when pushed (for AAR context). */
  pushedTurn: number;
  /** ISO wall-clock when completed/cleared. */
  resolvedAt?: string;
  /** Turn number when completed/cleared. */
  resolvedTurn?: number;
}

/** Recent weapon blast (audio + umpire truth). Cleared after a few turns. */
export interface WeaponDetonationEvent {
  id: string;
  kind:
    | 'depth_charge'
    | 'torpedo_hit'
    | 'aircraft_bomb'
    | 'deck_gun_fire'
    | 'deck_gun_hit'
    | 'deck_gun_miss';
  position: LatLonDepth;
  turnNumber: number;
  firerUnitId: string;
  /**
   * Hit / aim target for torpedo_hit / aircraft_bomb / deck_gun_hit —
   * involved hulls get Controls audio cues (aircraft firer is NPC and has no
   * station). Deck-gun fire cues are firer-only. Deck-gun miss may name the
   * nearest surface CPA for umpire GT map labels.
   */
  targetUnitId?: string;
  /**
   * Deck-gun true fire / aim heading (0–360) for umpire GT aim lines.
   * Omitted for non-gun detonations.
   */
  aimHeading?: number;
  /**
   * Wall-clock seconds after the client receives this cue before bridge SFX
   * (and the matching Damage-tab reveal) should play. Torpedo hits: compressed
   * presentation delay from intercept fraction within the turn (capped — see
   * `TORPEDO_HIT_AUDIO_MAX_DELAY_SEC`). Depth charges omit this and use the
   * client stagger schedule instead. Aircraft bombs use CPA fraction (same cap).
   * Deck-gun fire is staggered per round; deck-gun hit may use a short delay so the
   * cannon cue leads the explosion.
   */
  audioDelaySec?: number;
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
  /**
   * Access token embedded in vessel join URLs.
   * Omitted for umpire/NPC hulls that are not v1 player classes (oilers, carriers, …).
   * Playable Destroyer / Fleet Submarine units (Fletcher, Kagerō, Gato) always have one.
   */
  accessToken?: string;
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
   * Internal fraction while the mast is raised (0–1). Not a player control —
   * Sensors is binary raised/lowered. Raise defaults to 1; lower forces 0.
   * Any exposure &gt; 0 makes the feather visible to DD lookout in range
   * (deterministic FoW; no spot roll). Surface ships ignore this field.
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
   * Total ready torpedoes (forward + aft). Kept in sync for display /
   * legacy callers. Prefer room fields for fire / reload.
   */
  torpedoLoad: number;
  /** Forward room fish remaining (fleet subs; capacity 6). */
  torpedoForward: number;
  /** Aft room fish remaining (fleet subs; capacity 4). */
  torpedoAft: number;
  /** True after a forward salvo until a reload cycle completes. */
  torpedoForwardAwaitingReload: boolean;
  /** True after an aft salvo until a reload cycle completes. */
  torpedoAftAwaitingReload: boolean;
  /** Resolved turns left on an in-progress forward reload (0 = not counting). */
  torpedoForwardReloadTurnsRemaining: number;
  /** Resolved turns left on an in-progress aft reload (0 = not counting). */
  torpedoAftReloadTurnsRemaining: number;
  /**
   * Last fire order dropped at resolve for being outside the room's arc.
   * Player-facing on Controls; absent when the last order launched normally.
   */
  torpedoArcBlock?: TorpedoArcBlock;
  /**
   * Ready depth charges remaining (destroyers). 0 for non-DC hulls.
   * Consumed when a drop pattern launches on resolve.
   */
  depthChargeLoad: number;
  /** True after a DC drop until a reload cycle completes. */
  depthChargeAwaitingReload: boolean;
  /** Resolved turns left on an in-progress DC rack reload. */
  depthChargeReloadTurnsRemaining: number;
  /**
   * Ready bombs remaining (aircraft). Museum stub capacity 1; consumed on a
   * bombing-run resolve. Intercept / strafe use guns and do not consume.
   * 0 for non-aircraft. Umpire rearm restores a full load.
   */
  bombLoad: number;
  /**
   * Standing NPC aircraft loiter orbit. Absent when not loitering.
   * Persists across turns (not an orders field — survives resolve wipe).
   */
  aircraftLoiter?: AircraftLoiterState;
  /**
   * Ready deck-gun shells remaining (destroyers + fleet subs).
   * 0 for hulls without a deck gun. Consumed one per fire order on resolve.
   */
  deckGunLoad: number;
  /** True after a deck-gun shot until a reload cycle completes. */
  deckGunAwaitingReload: boolean;
  /** Resolved turns left on an in-progress deck-gun reload. */
  deckGunReloadTurnsRemaining: number;
  /**
   * Last deck-gun order dropped at resolve (e.g. sub submerged).
   * Player-facing on Controls; absent when the last order fired normally.
   */
  deckGunFireBlock?: DeckGunFireBlock;
  /**
   * Own-ship FoW contact designation book (Contact N).
   * Keys are target unit ids — umpire/GT only; never copied onto vessel views.
   * Vessel clients see only {@link RadarContact.labelN} / {@link PeriscopeContact.labelN}.
   */
  contactBook?: {
    nextLabel: number;
    byTargetId: Record<string, number>;
  };
  /**
   * Live-museum gopher task (umpire fiat errand). Absent when none ever
   * pushed. Terminal statuses (`completed`/`cleared`) are kept until the
   * next push replaces them — client cues only render while `active`.
   */
  gopherTask?: GopherTask;
  /**
   * Optional convoy / formation membership id (scenario-seeded or umpire).
   * Units sharing the same id receive group helm/EOT applies together.
   */
  formationId?: string;
  /**
   * When true, this hull no longer follows group orders for its
   * {@link formationId} (break-out). Membership id is kept for roster UX
   * until the umpire rejoins it.
   */
  formationDetached?: boolean;
}

/**
 * Scenario-level display name for a formation / convoy id.
 * Membership itself is on {@link ScenarioUnitSeed.formationId}.
 */
export interface ScenarioFormationSeed {
  id: string;
  name: string;
}

/**
 * Standing group helm/EOT for a convoy / formation (umpire-controlled).
 * Applied to non-detached members via the same course/EOT order model
 * used by individual vessels — not a separate kinematics path.
 */
export interface FormationState {
  id: string;
  name: string;
  /** Standing group course degrees true. */
  orderedCourse: number;
  /** Standing group EOT (queued onto followers as pending `orders.eot`). */
  eot: EotSetting;
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
  /**
   * Vessel join token. Required for playable Destroyer / Fleet Submarine seats
   * (Fletcher, Kagerō, Gato). Omit for umpire/NPC-only hulls (oilers, carriers, aircraft).
   */
  accessToken?: string;
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
  /** Optional ready torpedo count (fleet subs) — legacy; prefer room seeds. */
  torpedoLoad?: number;
  /** Optional forward room fish (fleet subs; default full = 6). */
  torpedoForward?: number;
  /** Optional aft room fish (fleet subs; default full = 4). */
  torpedoAft?: number;
  /** Optional ready depth-charge count (destroyers). */
  depthChargeLoad?: number;
  /** Optional ready bomb count (aircraft; default 1). */
  bombLoad?: number;
  /** Optional ready deck-gun shell count (destroyers + fleet subs). */
  deckGunLoad?: number;
  /**
   * Optional convoy / formation membership id. Units sharing an id move
   * under umpire group helm/EOT until individually detached.
   */
  formationId?: string;
  /** Optional seed: start detached from formation group orders. */
  formationDetached?: boolean;
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
  /**
   * Optional convoy / formation display names keyed by id.
   * Membership is on each unit's {@link ScenarioUnitSeed.formationId}.
   */
  formations?: ScenarioFormationSeed[];
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
  /**
   * Weapon tracks as of end-of-resolve (for umpire AAR scrubber).
   * Older saves may omit these; treat missing as [].
   */
  torpedoes?: TorpedoTrack[];
  depthCharges?: DepthChargeTrack[];
  /**
   * Umpire-authored note for this turn, shown alongside the resolve in the
   * After-Action Report. One note per turn (edit overwrites); optional.
   */
  umpireNote?: string;
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
  /**
   * Full state at scenario start (start of turn 1), before any resolve.
   * `history` entries are post-resolve, so history turn 1 is the end of turn 1
   * and cannot undo that turn. Rollback to turn 1 restores this snapshot.
   * Absent only on saves that already resolved turn 1 before the field existed.
   */
  openingSnapshot?: TurnSnapshot;
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
  /**
   * Standing convoy / formation group orders (umpire).
   * Rebuilt from unit membership on load when absent; empty when no formations.
   */
  formations?: FormationState[];
}

/** Kinds of umpire combat / action log lines. */
export type CombatLogKind =
  | 'torpedo_launch'
  | 'torpedo_hit'
  | 'torpedo_miss'
  | 'torpedo_expired'
  | 'depth_charge_drop'
  | 'depth_charge_detonation'
  | 'depth_charge_damage'
  | 'aircraft_attack'
  | 'aircraft_attack_damage'
  | 'aircraft_attack_miss'
  | 'deck_gun_fire'
  | 'deck_gun_hit'
  | 'deck_gun_miss'
  | 'unit_sunk'
  | 'hull_implosion'
  | 'subsystem_casualty'
  | 'gopher_task_pushed'
  | 'gopher_task_completed'
  | 'gopher_task_cleared';

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
  /**
   * Links this line to a {@link WeaponDetonationEvent.id} (e.g. `det-…`, `thit-…`)
   * so vessel Controls can reveal FoW damage with the matching blast SFX.
   * Umpire Action log still shows at resolve time — this is for client presentation.
   */
  sourceDetonationId?: string;
  /** Structured casualty when kind === subsystem_casualty. */
  casualtyEffect?: CasualtyEffect;
}

/**
 * Own-ship FoW damage line for Controls Damage report.
 * Never includes enemy full damage board — only events targeting this hull.
 */
export interface OwnDamageEvent {
  id: string;
  kind: Extract<
    CombatLogKind,
    | 'torpedo_hit'
    | 'depth_charge_damage'
    | 'aircraft_attack_damage'
    | 'deck_gun_hit'
    | 'unit_sunk'
    | 'hull_implosion'
    | 'subsystem_casualty'
  >;
  turnNumber: number;
  gameTimeSeconds: number;
  /** Operator-facing summary (no enemy GT beyond what own crew knows). */
  summary: string;
  damage?: number;
  /** Matching bridge / hydrophone detonation id when this line came from a blast. */
  sourceDetonationId?: string;
  /** Structured casualty when kind === subsystem_casualty (for staging / UI). */
  casualtyEffect?: CasualtyEffect;
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
  /**
   * End-of-turn snapshots for read-only AAR scrubbing on the umpire GT map.
   * Does not mutate live state (unlike rollback).
   */
  historySnapshots: TurnSnapshot[];
  vesselLinks: Array<{
    unitId: string;
    name: string;
    accessToken?: string;
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
  /**
   * Standing convoy / formation group orders (umpire GT only).
   * Empty when the scenario has no formation membership.
   */
  formations: FormationState[];
}

/**
 * Server-filtered radar contact (ARCH-SP-05 / ARCH-DET).
 * Polar only — never other units' absolute lat/lon or identity.
 */
export interface RadarContact {
  /** Opaque track id (stable while held). */
  id: string;
  /**
   * Stable Contact N for this hull (first-detection order on own ship).
   * Shared across radar / active sonar / periscope — not a display-list index.
   */
  labelN: number;
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
  /**
   * Active-sonar only: precise estimated keel depth (m, positive down),
   * ground truth rounded to the nearest whole meter for display — active
   * sonar is 100% accurate, same as radar. Omitted on radar contacts (0 when
   * the contact is on the surface).
   */
  estimatedDepthM?: number;
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
    | 'torpedoForward'
    | 'torpedoAft'
    | 'torpedoForwardAwaitingReload'
    | 'torpedoAftAwaitingReload'
    | 'torpedoForwardReloadTurnsRemaining'
    | 'torpedoAftReloadTurnsRemaining'
    | 'torpedoArcBlock'
    | 'depthChargeLoad'
    | 'depthChargeAwaitingReload'
    | 'depthChargeReloadTurnsRemaining'
    | 'deckGunLoad'
    | 'deckGunAwaitingReload'
    | 'deckGunReloadTurnsRemaining'
    | 'deckGunFireBlock'
    | 'gopherTask'
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
   * Also attached on Sensors (timing only — no SFX) so sunk popup / staged damage
   * can wait on the same delays. Polar only — range for gain attenuation; no
   * firer identity in FoW fields.
   */
  bridgeDetonations?: Array<{
    id: string;
    bearing: number;
    rangeNm: number;
    kind:
      | 'depth_charge'
      | 'torpedo_hit'
      | 'aircraft_bomb'
      | 'deck_gun_fire'
      | 'deck_gun_hit';
    /**
     * Seconds after the cue is heard before the one-shot (and Damage-tab line)
     * should play. Torpedo hits / aircraft bombs: compressed arrival delay (≤
     * `TORPEDO_HIT_AUDIO_MAX_DELAY_SEC`). Omitted for DC (client stagger).
     */
    audioDelaySec?: number;
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
   * Stable Contact N for this hull (first-detection order on own ship).
   * Shared with radar / active sonar — not a display-list index.
   * Periscope feathers use the same label as the submerged hull when known.
   */
  labelN: number;
  /**
   * `hull` = normal surface silhouette contact.
   * `periscope` = destroyer lookout spotted a raised periscope mast (FoW feather).
   */
  kind?: 'hull' | 'periscope';
  /**
   * Relative bearing degrees (−180, 180], instrument-precise (rounded to
   * the nearest whole degree for display — not FoW-coarsened).
   * Bow = 0; starboard positive; port negative.
   */
  relativeBearing: number;
  /** Precise range in nautical miles (rounded to 0.01 nm for display). */
  rangeNm: number;
  /**
   * Precise absolute speed in knots (rounded to 0.1 kn for display).
   * Always 0 for periscope feathers.
   */
  speedKn: number;
  /**
   * Precise true course degrees [0, 360) (rounded to the nearest whole
   * degree for display) — ground-truth heading read straight off the hull,
   * not a coarse visual estimate.
   * Used with relative bearing to mirror bow-right silhouette plates for port AOB.
   * Omitted for periscope feathers (`kind: 'periscope'`).
   */
  courseDeg?: number;
  /**
   * Hull class for silhouette mapping only
   * (Destroyer → destroyer.png, Fleet Submarine → submarine.png, Oiler → oiler.png,
   * Aircraft Carrier → carrier.png; Fighter/Bomber use `silhouettePlate` when set).
   * Not a side/name; other classes fall back to the destroyer plate.
   * Periscope feathers (`kind: 'periscope'`) use a stick/feather SVG in the
   * optics viewer, not a hull plate — `silhouetteClass` is FoW metadata only.
   */
  silhouetteClass: HullClass;
  /**
   * Optional class-specific plate stem when multiple library hulls share a
   * taxonomic class (e.g. Kagerō vs Fletcher both `Destroyer`; Zeke vs Hellcat
   * both `Fighter`). Values match public `/silhouettes/<plate>.png`
   * (e.g. `"kagero"`, `"zeke"`).
   * Identity is implied by the image only — not a side/name leak.
   */
  silhouettePlate?: string;
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
