/**
 * Lookout / periscope FoW Sightings — torpedo wakes + sink-aftermath markers.
 * Each cue carries sighting LOS (compass); wakes also carry travel secondary.
 */
import {
  PERISCOPE_MAX_RANGE_NM,
  coarsenWakeRelativeBearing,
  relativeBearingDeg,
  shortestBearingDelta,
  sinkAftermathDetectProbability,
  torpedoWakeDetectProbability,
  weaponRng01,
  bearingRangeNm,
  type GameSave,
  type OpticsSighting,
  type TorpedoWakeCue,
  type UnitState,
} from '@war-patrol/shared';

function buildWakeSightings(own: UnitState, save: GameSave): TorpedoWakeCue[] {
  const fish = (save.torpedoes ?? []).filter((t) => t.status === 'running');
  if (!fish.length) return [];

  const cues: TorpedoWakeCue[] = [];
  for (const t of fish) {
    if (t.firerUnitId === own.id) continue; // own fish — crew already knows
    const { bearing, rangeNm } = bearingRangeNm(own.position, t.position);
    if (rangeNm > Math.min(PERISCOPE_MAX_RANGE_NM, 2.5) || rangeNm <= 0) continue;
    const p = torpedoWakeDetectProbability(rangeNm);
    const roll = weaponRng01(`${save.id}|${own.id}|${t.id}|wake|${save.turn.number}`);
    if (roll > p) continue;
    // Sighting = where to look (LOS); travel = which way the wake is running.
    const sighting = coarsenWakeRelativeBearing(relativeBearingDeg(own.heading, bearing));
    const travel = coarsenWakeRelativeBearing(shortestBearingDelta(own.heading, t.heading));
    const confidence: TorpedoWakeCue['confidence'] = p >= 0.45 && rangeNm < 1.2 ? 'likely' : 'possible';
    cues.push({
      id: `wake-${t.id.slice(-6)}`,
      kind: 'wake',
      relativeBearing: sighting,
      travelRelativeBearing: travel,
      confidence,
    });
  }
  // Dedupe by sighting bearing bucket (same place on the rose).
  const seen = new Set<number>();
  return cues.filter((c) => {
    if (seen.has(c.relativeBearing)) return false;
    seen.add(c.relativeBearing);
    return true;
  });
}

function buildAftermathSightings(own: UnitState, save: GameSave): OpticsSighting[] {
  const markers = save.seaSurfaceMarkers ?? [];
  if (!markers.length) return [];

  const cues: OpticsSighting[] = [];
  for (const m of markers) {
    const { bearing, rangeNm } = bearingRangeNm(own.position, m.position);
    if (rangeNm > Math.min(PERISCOPE_MAX_RANGE_NM, 3.5) || rangeNm <= 0) continue;
    const p = sinkAftermathDetectProbability(rangeNm);
    const roll = weaponRng01(
      `${save.id}|${own.id}|${m.id}|sight|${save.turn.number}`,
    );
    if (roll > p) continue;
    cues.push({
      id: m.id,
      kind: m.kind,
      relativeBearing: coarsenWakeRelativeBearing(
        relativeBearingDeg(own.heading, bearing),
      ),
    });
  }
  // Keep distinct kinds even at the same bearing (debris + oil at one wreck).
  // Dedupe identical kind+bearing buckets only.
  const seen = new Set<string>();
  return cues.filter((c) => {
    const key = `${c.kind}:${c.relativeBearing}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * All optics Sightings for an observer (wake + sink aftermath).
 * Caller gates on lookout capability + periscope/lookout operational.
 */
export function buildOpticsSightings(own: UnitState, save: GameSave): OpticsSighting[] {
  return [...buildWakeSightings(own, save), ...buildAftermathSightings(own, save)];
}

/** @deprecated Prefer {@link buildOpticsSightings}. Wake-only subset. */
export function buildTorpedoWakeCues(own: UnitState, save: GameSave): TorpedoWakeCue[] {
  return buildWakeSightings(own, save);
}
