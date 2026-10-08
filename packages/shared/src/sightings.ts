/**
 * Optics Sightings — wake FoW helpers + sink-aftermath sea-surface markers.
 *
 * Aftermath markers (debris / oil / life rafts / downed pilot) are permanent
 * world state for the scenario: they stay on the save until rollback / scenario
 * end. Vessel Sightings appear/disappear from FoW range only — not a turn timer.
 * Wakes remain ephemeral (recomputed from running fish; no save markers).
 */
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

/**
 * Identity copy for call-site compatibility.
 * Aftermath markers are permanent world state (scenario lifetime); age-based
 * turn pruning was removed so debris / oil / rafts / pilots stay while the
 * observer can leave and re-enter FoW range. Rollback still drops markers
 * created after the restored turn via `createdTurn` filtering in turnEngine.
 *
 * `turnNumber` / `retentionTurns` are ignored (kept optional for callers).
 */
export function pruneSeaSurfaceMarkers(
  markers: readonly SeaSurfaceMarker[],
  _turnNumber?: number,
  _retentionTurns?: number,
): SeaSurfaceMarker[] {
  return [...markers];
}

/**
 * Merge prior markers with newly spawned ones.
 * Markers persist for the scenario (no turn-age prune).
 * `resolveTurnNumber` is the turn being resolved (markers stamp with that number).
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
  return [...opts.priorMarkers, ...spawned];
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
  return [...opts.existing, ...spawned];
}
