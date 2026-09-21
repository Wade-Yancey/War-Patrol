import type { HullClass } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/**
 * Approximate WWII overall length (meters) by taxonomic class.
 * Round numbers for collision / combat stubs — not survey precision.
 *
 * Representative references:
 * - Fleet Submarine ~ Gato OA ~95 m
 * - Destroyer ~ Fletcher OA ~115 m
 * - Cruiser ~ Cleveland OA ~186 m
 * - Aircraft Carrier ~ Essex OA ~266 m
 * - Merchant ~ Liberty OA ~135 m
 * - Oiler ~ Cimarron OA ~169 m
 * - Battleship ~ Iowa OA ~270 m
 * - Fighter ~ Hellcat fuselage ~10 m
 * - Bomber ~ Avenger fuselage ~12 m
 */
export const CLASS_LENGTH_M: Record<HullClass, number> = {
  'Fleet Submarine': 95,
  Destroyer: 115,
  Cruiser: 186,
  'Aircraft Carrier': 266,
  Merchant: 135,
  Oiler: 169,
  Battleship: 270,
  Fighter: 10,
  Bomber: 12,
};

/**
 * Approximate beam / width (meters) by taxonomic class.
 * Ships/subs: waterline beam. Aircraft: wingspan (collision footprint).
 *
 * Representative references:
 * - Fleet Submarine ~ Gato ~8.3 m
 * - Destroyer ~ Fletcher ~12 m
 * - Cruiser ~ Cleveland ~20 m
 * - Aircraft Carrier ~ Essex waterline ~28 m
 * - Merchant ~ Liberty ~17 m
 * - Oiler ~ Cimarron ~23 m
 * - Battleship ~ Iowa ~33 m
 * - Fighter ~ Hellcat wingspan ~13 m
 * - Bomber ~ Avenger wingspan ~17 m
 */
export const CLASS_BEAM_M: Record<HullClass, number> = {
  'Fleet Submarine': 8.3,
  Destroyer: 12,
  Cruiser: 20,
  'Aircraft Carrier': 28,
  Merchant: 17,
  Oiler: 23,
  Battleship: 33,
  Fighter: 13,
  Bomber: 17,
};

const DEFAULT_LENGTH_M = CLASS_LENGTH_M.Destroyer;
const DEFAULT_BEAM_M = CLASS_BEAM_M.Destroyer;

/** Class default overall length (meters). */
export function defaultLengthM(hullClass: HullClass): number {
  return CLASS_LENGTH_M[hullClass] ?? DEFAULT_LENGTH_M;
}

/** Class default beam / wingspan (meters). */
export function defaultBeamM(hullClass: HullClass): number {
  return CLASS_BEAM_M[hullClass] ?? DEFAULT_BEAM_M;
}

function resolveHullClass(opts: {
  class?: HullClass | string;
  type?: string;
}): HullClass {
  const { class: hullClass } = resolveVesselIdentity({
    type: opts.type ?? opts.class,
    class: isHullClass(opts.class) ? opts.class : undefined,
  });
  return hullClass;
}

/**
 * Resolve lengthM: explicit positive override wins; else class enum default.
 */
export function resolveLengthM(opts: {
  lengthM?: number;
  class?: HullClass | string;
  type?: string;
}): number {
  if (typeof opts.lengthM === 'number' && Number.isFinite(opts.lengthM) && opts.lengthM > 0) {
    return opts.lengthM;
  }
  return defaultLengthM(resolveHullClass(opts));
}

/**
 * Resolve beamM: explicit positive override wins; else class enum default.
 * Aircraft use wingspan as beam.
 */
export function resolveBeamM(opts: {
  beamM?: number;
  class?: HullClass | string;
  type?: string;
}): number {
  if (typeof opts.beamM === 'number' && Number.isFinite(opts.beamM) && opts.beamM > 0) {
    return opts.beamM;
  }
  return defaultBeamM(resolveHullClass(opts));
}

/**
 * Recognition-manual plate for the torpedo calculator.
 * Operators look up OA length here (same numbers as class / library stubs)
 * and enter it as the TDC length estimate — never auto-filled from FoW.
 */
export interface RecognitionManualEntry {
  /** Plate title (concrete exemplar name). */
  name: string;
  class: HullClass;
  lengthM: number;
  beamM: number;
}

/**
 * Surface / sub recognition plates used beside the torpedo length field.
 * Aircraft omitted (not torpedo targets in v1). Lengths match {@link CLASS_LENGTH_M}.
 */
export const RECOGNITION_MANUAL_ENTRIES: readonly RecognitionManualEntry[] = [
  {
    name: 'Gato-class Fleet Submarine',
    class: 'Fleet Submarine',
    lengthM: CLASS_LENGTH_M['Fleet Submarine'],
    beamM: CLASS_BEAM_M['Fleet Submarine'],
  },
  {
    name: 'Fletcher-class Destroyer',
    class: 'Destroyer',
    lengthM: CLASS_LENGTH_M.Destroyer,
    beamM: CLASS_BEAM_M.Destroyer,
  },
  {
    name: 'Cleveland-class Cruiser',
    class: 'Cruiser',
    lengthM: CLASS_LENGTH_M.Cruiser,
    beamM: CLASS_BEAM_M.Cruiser,
  },
  {
    name: 'Essex-class Aircraft Carrier',
    class: 'Aircraft Carrier',
    lengthM: CLASS_LENGTH_M['Aircraft Carrier'],
    beamM: CLASS_BEAM_M['Aircraft Carrier'],
  },
  {
    name: 'Liberty-class Merchant',
    class: 'Merchant',
    lengthM: CLASS_LENGTH_M.Merchant,
    beamM: CLASS_BEAM_M.Merchant,
  },
  {
    name: 'Cimarron-class Oiler',
    class: 'Oiler',
    lengthM: CLASS_LENGTH_M.Oiler,
    beamM: CLASS_BEAM_M.Oiler,
  },
  {
    name: 'Iowa-class Battleship',
    class: 'Battleship',
    lengthM: CLASS_LENGTH_M.Battleship,
    beamM: CLASS_BEAM_M.Battleship,
  },
];
