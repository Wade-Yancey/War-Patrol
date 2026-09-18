import type { HullClass, VesselType } from './types.js';

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

/** Type required by a hull class (e.g. Fleet Submarine → Submarine). */
export function typeForClass(hullClass: HullClass): VesselType {
  return CLASS_TO_TYPE[hullClass];
}

/** Classes allowed for a given type. */
export function classesForType(type: VesselType): HullClass[] {
  return HULL_CLASSES.filter((c) => CLASS_TO_TYPE[c] === type);
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
