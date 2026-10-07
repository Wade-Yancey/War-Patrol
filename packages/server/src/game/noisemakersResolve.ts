/**
 * Resolve fleet-sub noisemaker countermeasure deploys and lifetimes.
 */
import { nanoid } from 'nanoid';
import {
  advanceNoisemakerCooldown,
  advanceNoisemakerTracks,
  armNoisemakerCooldown,
  canDeployNoisemaker,
  clampNoisemakerDepthM,
  createNoisemakerTrack,
  type CombatLogEntry,
  type NoisemakerTrack,
  type UnitState,
} from '@war-patrol/shared';
import { logLine } from './combatLog.js';

export type NoisemakersResolveResult = {
  units: UnitState[];
  noisemakers: NoisemakerTrack[];
  combatLogEntries: CombatLogEntry[];
};

/**
 * Tick cooldowns, deploy pending orders at post-kinematics lat/lon + chosen depth,
 * then expire aged decoys. Stationary — position never follows the sub afterward.
 */
export function resolveNoisemakersForTurn(
  unitsIn: UnitState[],
  priorNoisemakers: NoisemakerTrack[],
  turnNumber: number,
  gameTimeSeconds: number,
): NoisemakersResolveResult {
  const combatLogEntries: CombatLogEntry[] = [];
  const launched: NoisemakerTrack[] = [];

  const units = unitsIn.map((unit) => {
    let next = advanceNoisemakerCooldown(unit);
    const order = unit.orders.deployNoisemaker;
    if (order && canDeployNoisemaker(next)) {
      const depthM = clampNoisemakerDepthM(order.depthM);
      const track = createNoisemakerTrack({
        id: `nm-${nanoid(8)}`,
        deployerUnitId: unit.id,
        position: {
          lat: unit.position.lat,
          lon: unit.position.lon,
          depth: depthM,
        },
        deployedTurn: turnNumber,
      });
      launched.push(track);
      next = armNoisemakerCooldown(next);
      combatLogEntries.push(
        logLine({
          kind: 'noisemaker_deploy',
          turnNumber,
          gameTimeSeconds,
          actor: unit,
          summary: `${unit.name} deployed noisemaker · set ${depthM} m (stationary)`,
        }),
      );
    }
    if (next.orders.deployNoisemaker) {
      const { deployNoisemaker: _n, ...rest } = next.orders;
      next = { ...next, orders: rest };
    }
    return next;
  });

  const noisemakers = advanceNoisemakerTracks(
    [...(priorNoisemakers ?? []), ...launched],
    turnNumber,
  );

  return { units, noisemakers, combatLogEntries };
}
