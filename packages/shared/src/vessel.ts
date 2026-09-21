import { SUBMARINE_MAX_DEPTH_M } from './constants.js';
import { clampSubmarineDepth } from './dive.js';
import type {
  Faction,
  FlightLevel,
  HullClass,
  UnitCondition,
  UnitState,
  UnitSubsystems,
  VesselType,
} from './types.js';

/** High-level vessel kinds (platform category). */
export const VESSEL_TYPES: readonly VesselType[] = ['Submarine', 'Ship', 'Aircraft'];

/** Taxonomic hull / airframe classes. */
export const HULL_CLASSES: readonly HullClass[] = [
  'Fleet Submarine',
  'Destroyer',
  'Cruiser',
  'Aircraft Carrier',
  'Merchant',
  'Oiler',
  'Battleship',
  'Fighter',
  'Bomber',
];

export const FACTIONS: readonly Faction[] = ['Blue', 'Red', 'Civilian'];

export const FLIGHT_LEVELS: readonly FlightLevel[] = ['low', 'medium', 'high'];

export const UNIT_CONDITIONS: readonly UnitCondition[] = ['afloat', 'sunk'];

export const SUBSYSTEM_STATES = ['intact', 'disabled'] as const;

/** Canonical class → type mapping. */
export const CLASS_TO_TYPE: Record<HullClass, VesselType> = {
  'Fleet Submarine': 'Submarine',
  Destroyer: 'Ship',
  Cruiser: 'Ship',
  'Aircraft Carrier': 'Ship',
  Merchant: 'Ship',
  Oiler: 'Ship',
  Battleship: 'Ship',
  Fighter: 'Aircraft',
  Bomber: 'Aircraft',
};

const HULL_CLASS_SET = new Set<string>(HULL_CLASSES);
const VESSEL_TYPE_SET = new Set<string>(VESSEL_TYPES);
const FLIGHT_LEVEL_SET = new Set<string>(FLIGHT_LEVELS);
const FACTION_SET = new Set<string>(FACTIONS);

/** Legacy Phase-1 `type` values before Submarine|Ship|Aircraft split. */
const LEGACY_TYPE_MAP: Record<string, { type: VesselType; class: HullClass }> = {
  submarine: { type: 'Submarine', class: 'Fleet Submarine' },
  destroyer: { type: 'Ship', class: 'Destroyer' },
  cruiser: { type: 'Ship', class: 'Cruiser' },
  merchant: { type: 'Ship', class: 'Merchant' },
  other: { type: 'Ship', class: 'Merchant' },
};

export function isVesselType(value: unknown): value is VesselType {
  return typeof value === 'string' && VESSEL_TYPE_SET.has(value);
}

export function isHullClass(value: unknown): value is HullClass {
  return typeof value === 'string' && HULL_CLASS_SET.has(value);
}

export function isFlightLevel(value: unknown): value is FlightLevel {
  return typeof value === 'string' && FLIGHT_LEVEL_SET.has(value);
}

export function isFaction(value: unknown): value is Faction {
  return typeof value === 'string' && FACTION_SET.has(value);
}

/** Type required by a hull class (e.g. Fleet Submarine → Submarine). */
export function typeForClass(hullClass: HullClass): VesselType {
  return CLASS_TO_TYPE[hullClass];
}

/** Classes allowed for a given type. */
export function classesForType(type: VesselType): HullClass[] {
  return HULL_CLASSES.filter((c) => CLASS_TO_TYPE[c] === type);
}

/**
 * Hull classes with **player station flows** in the first iteration.
 * Cruiser / carrier / merchant / oiler / battleship / aircraft may exist as
 * umpire/NPC units later, but v1 only links stations for Destroyer + Fleet Submarine.
 */
export const V1_PLAYER_HULL_CLASSES: readonly HullClass[] = [
  'Destroyer',
  'Fleet Submarine',
];

const V1_PLAYER_CLASS_SET = new Set<string>(V1_PLAYER_HULL_CLASSES);

/** True when this hull class gets player join URLs / station auth in v1. */
export function isV1PlayerHullClass(hullClass: HullClass | string | undefined): boolean {
  return typeof hullClass === 'string' && V1_PLAYER_CLASS_SET.has(hullClass);
}

/** True when the unit is a v1 player vessel (DD or fleet sub). */
export function isV1PlayerUnit(unit: {
  type?: unknown;
  class?: unknown;
  classId?: unknown;
}): boolean {
  const { class: hullClass } = resolveVesselIdentity(unit);
  return isV1PlayerHullClass(hullClass);
}

/**
 * Resolve type + class from possibly-legacy save/scenario fields.
 * Prefers explicit valid `class`; coerces `type` to match; migrates old enums.
 */
export function resolveVesselIdentity(input: {
  type?: unknown;
  class?: unknown;
  classId?: unknown;
}): { type: VesselType; class: HullClass } {
  const rawClass = input.class;
  if (isHullClass(rawClass)) {
    return { type: typeForClass(rawClass), class: rawClass };
  }

  const rawType = typeof input.type === 'string' ? input.type : '';

  // Modern type without class → default class for that type
  if (isVesselType(rawType)) {
    const defaults: Record<VesselType, HullClass> = {
      Submarine: 'Fleet Submarine',
      Ship: 'Destroyer',
      Aircraft: 'Fighter',
    };
    return { type: rawType, class: defaults[rawType] };
  }

  const legacy = LEGACY_TYPE_MAP[rawType];
  if (legacy) return legacy;

  // Hint from library classId when present
  const classId = typeof input.classId === 'string' ? input.classId.toLowerCase() : '';
  if (classId.includes('gato') || classId.includes('sub')) {
    return { type: 'Submarine', class: 'Fleet Submarine' };
  }
  if (classId.includes('fletcher') || classId.includes('destroy')) {
    return { type: 'Ship', class: 'Destroyer' };
  }

  return { type: 'Ship', class: 'Destroyer' };
}

/** Ensure class↔type pair is consistent; class wins when both present. */
export function coerceVesselIdentity(
  type: VesselType | undefined,
  hullClass: HullClass | undefined,
): { type: VesselType; class: HullClass } {
  return resolveVesselIdentity({ type, class: hullClass });
}

/**
 * Resolve faction from explicit value, legacy `side`, hull class, or default Blue.
 * Merchants/Oilers default Civilian when nothing else indicates allegiance.
 */
export function resolveFaction(input: {
  faction?: unknown;
  side?: unknown;
  class?: HullClass | string;
}): Faction {
  if (isFaction(input.faction)) return input.faction;

  const side = typeof input.side === 'string' ? input.side.trim().toLowerCase() : '';
  if (side === 'blue' || side === 'blu') return 'Blue';
  if (side === 'red') return 'Red';
  if (side === 'civilian' || side === 'neutral' || side === 'white') return 'Civilian';

  // Capitalized legacy side strings
  if (typeof input.side === 'string') {
    const titled = input.side.trim();
    if (isFaction(titled)) return titled;
  }

  if (input.class === 'Merchant' || input.class === 'Oiler') return 'Civilian';

  return 'Blue';
}

/** Keep legacy `side` lowercase id aligned with faction. */
export function sideFromFaction(faction: Faction): string {
  switch (faction) {
    case 'Blue':
      return 'blue';
    case 'Red':
      return 'red';
    case 'Civilian':
      return 'civilian';
  }
}

/** CSS / map color key for a faction. */
export function factionAccent(faction: Faction): 'blue' | 'red' | 'civilian' {
  return sideFromFaction(faction) as 'blue' | 'red' | 'civilian';
}

/**
 * Speed table / clamp helpers live in {@link ./performance.js} (re-exported from
 * package root). Kept out of this module to avoid duplicate `export *` names.
 */

export function defaultSubsystems(): UnitSubsystems {
  return { propulsion: 'intact', sensors: 'intact' };
}

export function resolveSubsystems(
  partial?: Partial<UnitSubsystems> | null,
): UnitSubsystems {
  const d = defaultSubsystems();
  if (!partial) return d;
  return {
    propulsion: partial.propulsion === 'disabled' ? 'disabled' : 'intact',
    sensors: partial.sensors === 'disabled' ? 'disabled' : 'intact',
  };
}

export function resolveCondition(value: unknown): UnitCondition {
  return value === 'sunk' ? 'sunk' : 'afloat';
}

export function resolveFlightLevel(
  type: VesselType,
  value: unknown,
): FlightLevel | undefined {
  if (type !== 'Aircraft') return undefined;
  if (isFlightLevel(value)) return value;
  return 'medium';
}

/** True when unit can still make way under its own power. */
export function canMakeWay(unit: Pick<UnitState, 'condition' | 'subsystems'>): boolean {
  return unit.condition !== 'sunk' && unit.subsystems?.propulsion !== 'disabled';
}

/** True when unit still exists as a radar/contactable target. */
export function isRadarTargetable(unit: Pick<UnitState, 'condition'>): boolean {
  return unit.condition !== 'sunk';
}

/** Own-ship radar set usable (not sunk, sensors intact). */
export function canUseSensors(
  unit: Pick<UnitState, 'condition' | 'subsystems'>,
): { ok: boolean; reason?: 'sunk' | 'sensors_disabled' } {
  if (unit.condition === 'sunk') return { ok: false, reason: 'sunk' };
  if (unit.subsystems?.sensors === 'disabled') return { ok: false, reason: 'sensors_disabled' };
  return { ok: true };
}

/**
 * Normalize position elevation rules by type:
 * - Ship → depth 0 (surface only)
 * - Aircraft → depth 0 (flight level is separate)
 * - Submarine → keep depth (clamped by caller when ordering)
 */
export function normalizePositionForType(
  type: VesselType,
  position: { lat: number; lon: number; depth: number },
): { lat: number; lon: number; depth: number } {
  if (type === 'Ship' || type === 'Aircraft') {
    return { ...position, depth: 0 };
  }
  return {
    ...position,
    depth: Math.max(0, Math.min(SUBMARINE_MAX_DEPTH_M, position.depth)),
  };
}

/** Standing ordered depth: ships/aircraft 0; subs default to current depth (coarse). */
export function resolveOrderedDepth(
  type: VesselType,
  positionDepth: number,
  orderedDepth?: number,
): number {
  if (type === 'Ship' || type === 'Aircraft') return 0;
  const raw =
    typeof orderedDepth === 'number' && Number.isFinite(orderedDepth)
      ? orderedDepth
      : positionDepth;
  return clampSubmarineDepth(raw);
}

/** Operator label for sunk/destroyed by type. */
export function conditionLabel(type: VesselType, condition: UnitCondition): string {
  if (condition === 'afloat') return type === 'Aircraft' ? 'Airborne' : 'Afloat';
  return type === 'Aircraft' ? 'Destroyed' : 'Sunk';
}
