/**
 * Optics Sightings — wake FoW helpers + sink-aftermath sea-surface markers.
 */
import { SINK_AFTERMATH_RETENTION_TURNS } from './constants.js';
import { clamp } from './geo.js';
import type {
  LatLonDepth,
  OpticsSightingKind,
  SeaSurfaceMarker,
  SeaSurfaceMarkerKind,
  UnitState,
} from './types.js';
import { isHullLost } from './vessel.js';
import {
  SINK_AFTERMATH_BASE_P,
  SINK_AFTERMATH_DETECT_MAX_NM,
} from './weapons.js';

/** Operator CRT label for a Sighting kind. */
export function opticsSightingLabel(kind: OpticsSightingKind): string {
  switch (kind) {
    case 'wake':
      return 'WAKE';
    case 'debris':
      return 'DEBRIS';
    case 'oil':
      return 'OIL';
    case 'life_rafts':
      return 'LIFE RAFTS';
    case 'downed_pilot':
      return 'PILOT';
    default:
      return 'SIGHTING';
  }
}

export function sinkAftermathDetectProbability(rangeNm: number): number {
  if (rangeNm <= 0 || rangeNm > SINK_AFTERMATH_DETECT_MAX_NM) return 0;
  const proximity = 1 - rangeNm / SINK_AFTERMATH_DETECT_MAX_NM;
  return clamp(SINK_AFTERMATH_BASE_P * (0.4 + 0.6 * proximity), 0, 0.9);
}

/** Which aftermath marker kinds to spawn when a unit first becomes hull-lost. */
export function sinkAftermathKindsForUnit(
  unit: Pick<UnitState, 'type'>,
): SeaSurfaceMarkerKind[] {
  if (unit.type === 'Aircraft') return ['downed_pilot'];
  if (unit.type === 'Ship') return ['debris', 'oil', 'life_rafts'];
  // Submarines: debris + oil only (no life rafts — surface-vessel callout).
  if (unit.type === 'Submarine') return ['debris', 'oil'];
  return [];
}

function surfacePos(unit: Pick<UnitState, 'position'>): LatLonDepth {
  return { lat: unit.position.lat, lon: unit.position.lon, depth: 0 };
}

/**
 * Build new markers for units that just entered sinking/sunk.
 * Skips units that already have any marker (idempotent across resolve + umpire).
 */
export function createSinkAftermathMarkers(opts: {
  priorUnits: readonly UnitState[];
  nextUnits: readonly UnitState[];
  turnNumber: number;
  existing: readonly SeaSurfaceMarker[];
}): SeaSurfaceMarker[] {
  const priorById = new Map(opts.priorUnits.map((u) => [u.id, u]));
  const already = new Set(opts.existing.map((m) => m.sourceUnitId));
  const created: SeaSurfaceMarker[] = [];

  for (const unit of opts.nextUnits) {
    if (!isHullLost(unit.condition)) continue;
    const prev = priorById.get(unit.id);
    if (prev && isHullLost(prev.condition)) continue;
    if (already.has(unit.id)) continue;

    const kinds = sinkAftermathKindsForUnit(unit);
    if (!kinds.length) continue;
    const pos = surfacePos(unit);
    const short = unit.id.slice(-6);
    for (const kind of kinds) {
      created.push({
        id: `${kind}-${short}-${opts.turnNumber}`,
        kind,
        position: { ...pos },
        createdTurn: opts.turnNumber,
        sourceUnitId: unit.id,
      });
    }
    already.add(unit.id);
  }
  return created;
}

/** Drop markers older than the retention window relative to `turnNumber`. */
export function pruneSeaSurfaceMarkers(
  markers: readonly SeaSurfaceMarker[],
  turnNumber: number,
  retentionTurns: number = SINK_AFTERMATH_RETENTION_TURNS,
): SeaSurfaceMarker[] {
  const oldest = turnNumber - retentionTurns;
  return markers.filter((m) => m.createdTurn >= oldest);
}

/**
 * Merge prior markers with newly spawned ones, then prune by retention.
 * `resolveTurnNumber` is the turn being resolved (markers stamp with that number).
 * Prune uses the post-resolve open turn (`resolveTurnNumber + 1`) so a marker
 * created this resolve remains for the full retention window of openings.
 */
export function advanceSeaSurfaceMarkers(opts: {
  priorUnits: readonly UnitState[];
  nextUnits: readonly UnitState[];
  resolveTurnNumber: number;
  priorMarkers: readonly SeaSurfaceMarker[];
}): SeaSurfaceMarker[] {
  const spawned = createSinkAftermathMarkers({
    priorUnits: opts.priorUnits,
    nextUnits: opts.nextUnits,
    turnNumber: opts.resolveTurnNumber,
    existing: opts.priorMarkers,
  });
  const merged = [...opts.priorMarkers, ...spawned];
  // Retain relative to the new open turn number after resolve.
  return pruneSeaSurfaceMarkers(merged, opts.resolveTurnNumber + 1);
}

/**
 * Umpire fiat: if a unit is newly hull-lost via patch, append markers now.
 * Uses the current open turn number as `createdTurn`.
 */
export function appendSinkAftermathForUnit(opts: {
  prior: UnitState;
  next: UnitState;
  turnNumber: number;
  existing: readonly SeaSurfaceMarker[];
}): SeaSurfaceMarker[] {
  if (isHullLost(opts.prior.condition) || !isHullLost(opts.next.condition)) {
    return [...opts.existing];
  }
  const spawned = createSinkAftermathMarkers({
    priorUnits: [opts.prior],
    nextUnits: [opts.next],
    turnNumber: opts.turnNumber,
    existing: opts.existing,
  });
  return pruneSeaSurfaceMarkers([...opts.existing, ...spawned], opts.turnNumber);
}
