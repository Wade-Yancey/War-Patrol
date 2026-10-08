/**
 * Lookout / periscope FoW — chance to notice a torpedo wake (not identity).
 * Cue carries sighting LOS (compass) + travel direction (secondary text).
 */
import {
  PERISCOPE_MAX_RANGE_NM,
  coarsenWakeRelativeBearing,
  relativeBearingDeg,
  shortestBearingDelta,
  torpedoWakeDetectProbability,
  weaponRng01,
  bearingRangeNm,
  type GameSave,
  type TorpedoWakeCue,
  type UnitState,
} from '@war-patrol/shared';

export function buildTorpedoWakeCues(own: UnitState, save: GameSave): TorpedoWakeCue[] {
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
