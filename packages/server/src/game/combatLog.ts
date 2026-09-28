/**
 * Shared combat-log line builders (torpedo/DC, deck gun, aircraft).
 */
import { nanoid } from 'nanoid';
import {
  formatCasualtySummary,
  type CasualtyEffect,
  type CombatLogEntry,
  type CombatLogKind,
  type UnitState,
} from '@war-patrol/shared';

/** Exported for immediate (non-turn-resolve) combat log lines, e.g. gopher tasks. */
export function logLine(opts: {
  kind: CombatLogKind;
  turnNumber: number;
  gameTimeSeconds: number;
  summary: string;
  actor?: UnitState;
  target?: UnitState;
  damage?: number;
  /** Bridge / audio detonation id this combat effect came from. */
  sourceDetonationId?: string;
  casualtyEffect?: CasualtyEffect;
}): CombatLogEntry {
  return {
    id: `cl-${nanoid(8)}`,
    kind: opts.kind,
    turnNumber: opts.turnNumber,
    gameTimeSeconds: opts.gameTimeSeconds,
    at: new Date().toISOString(),
    summary: opts.summary,
    actorUnitId: opts.actor?.id,
    actorName: opts.actor?.name,
    targetUnitId: opts.target?.id,
    targetName: opts.target?.name,
    damage: opts.damage,
    ...(opts.sourceDetonationId ? { sourceDetonationId: opts.sourceDetonationId } : {}),
    ...(opts.casualtyEffect ? { casualtyEffect: opts.casualtyEffect } : {}),
  };
}

export function logCasualtyEffects(
  target: UnitState,
  effects: CasualtyEffect[],
  opts: {
    turnNumber: number;
    gameTimeSeconds: number;
    actor?: UnitState;
    sourceDetonationId?: string;
  },
): CombatLogEntry[] {
  return effects.map((effect) =>
    logLine({
      kind: 'subsystem_casualty',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      actor: opts.actor,
      target,
      summary: formatCasualtySummary(target.name, effect),
      sourceDetonationId: opts.sourceDetonationId,
      casualtyEffect: effect,
    }),
  );
}
