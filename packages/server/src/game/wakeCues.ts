/**
 * Lookout / periscope FoW — chance to notice torpedo wake direction (not identity).
 */
import {
  PERISCOPE_MAX_RANGE_NM,
  coarsenWakeRelativeBearing,
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
    const { rangeNm } = bearingRangeNm(own.position, t.position);
    if (rangeNm > Math.min(PERISCOPE_MAX_RANGE_NM, 2.5) || rangeNm <= 0) continue;
    const p = torpedoWakeDetectProbability(rangeNm);
    const roll = weaponRng01(`${save.id}|${own.id}|${t.id}|wake|${save.turn.number}`);
    if (roll > p) continue;
    // Cue = direction the wake is traveling (fish heading), relative to own bow.
    const rel = coarsenWakeRelativeBearing(shortestBearingDelta(own.heading, t.heading));
    const confidence: TorpedoWakeCue['confidence'] = p >= 0.45 && rangeNm < 1.2 ? 'likely' : 'possible';
    cues.push({
      id: `wake-${t.id.slice(-6)}`,
      relativeBearing: rel,
      confidence,
    });
  }
  // Dedupe by relative bearing bucket
  const seen = new Set<number>();
  return cues.filter((c) => {
    if (seen.has(c.relativeBearing)) return false;
    seen.add(c.relativeBearing);
    return true;
  });
}
