import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HEALTH_PROPULSION_DISABLED_BELOW,
  HEALTH_SENSORS_DISABLED_BELOW,
  type OwnDamageEvent,
  type UnitCondition,
  type UnitSubsystems,
  type VesselView,
} from '@war-patrol/shared';

export type ScheduleDamageReveal = (detonationId: string, whenSec: number) => void;

export type SyncedDamagePresentation = {
  damageLog: OwnDamageEvent[];
  health: number;
  condition: UnitCondition;
  subsystems: UnitSubsystems;
  /** Register from Controls bridge audio flush so reveals share `whenSec`. */
  scheduleRevealForDetonation: ScheduleDamageReveal;
};

/**
 * Stage Controls Damage-report UI until the matching bridge blast SFX plays.
 *
 * Sim / vessel health stay at resolve-time truth; only the Damage tab presentation
 * is held. Entries without a live `bridgeDetonations` cue (or no
 * `sourceDetonationId`) reveal immediately. DC cues use the stagger `whenSec`;
 * torpedo-hit cues use `audioDelaySec` (arrival inside the resolved turn).
 * Umpire Action log is untouched.
 */
export function useAudioSyncedDamageReport(
  fullLog: OwnDamageEvent[] | undefined,
  bridgeDetonations: VesselView['bridgeDetonations'],
  unit: {
    health: number;
    condition: UnitCondition;
    subsystems: UnitSubsystems;
  } | null,
): SyncedDamagePresentation {
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const fullLogRef = useRef(fullLog);
  fullLogRef.current = fullLog;
  const timersRef = useRef<number[]>([]);

  const revealDetonation = useCallback((detonationId: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const e of fullLogRef.current ?? []) {
        if (e.sourceDetonationId === detonationId && !next.has(e.id)) {
          next.add(e.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const scheduleRevealForDetonation = useCallback<ScheduleDamageReveal>(
    (detonationId, whenSec) => {
      const delaySec = Math.max(0, whenSec);
      if (delaySec <= 0) {
        revealDetonation(detonationId);
        return;
      }
      const t = window.setTimeout(() => revealDetonation(detonationId), delaySec * 1000);
      timersRef.current.push(t);
    },
    [revealDetonation],
  );

  useEffect(() => {
    return () => {
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  // Reveal anything not waiting on a live bridge cue (history, crush, expired cues).
  useEffect(() => {
    const log = fullLog ?? [];
    const live = new Set((bridgeDetonations ?? []).map((d) => d.id));
    setRevealedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of [...next]) {
        if (!log.some((e) => e.id === id)) {
          next.delete(id);
          changed = true;
        }
      }
      for (const e of log) {
        if (next.has(e.id)) continue;
        if (!e.sourceDetonationId || !live.has(e.sourceDetonationId)) {
          next.add(e.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [fullLog, bridgeDetonations]);

  return useMemo(() => {
    const log = fullLog ?? [];
    if (!unit) {
      return {
        damageLog: log.filter((e) => revealedIds.has(e.id)),
        health: 100,
        condition: 'afloat' as const,
        subsystems: { propulsion: 'intact' as const, sensors: 'intact' as const },
        scheduleRevealForDetonation,
      };
    }

    const damageLog = log.filter((e) => revealedIds.has(e.id));
    const held = log.filter((e) => !revealedIds.has(e.id));

    let health = unit.health;
    for (const e of held) {
      if (
        (e.kind === 'depth_charge_damage' || e.kind === 'torpedo_hit') &&
        e.damage != null &&
        e.damage > 0
      ) {
        health = Math.min(100, health + e.damage);
      }
    }

    const heldFatal = held.some((e) => e.kind === 'unit_sunk' || e.kind === 'hull_implosion');
    // Keep afloat while a linked fatal line is still waiting on its blast cue.
    const condition: UnitCondition = heldFatal || health > 0 ? 'afloat' : 'sunk';

    const subsystems: UnitSubsystems = {
      propulsion: health < HEALTH_PROPULSION_DISABLED_BELOW ? 'disabled' : 'intact',
      sensors: health < HEALTH_SENSORS_DISABLED_BELOW ? 'disabled' : 'intact',
    };

    return {
      damageLog,
      health,
      condition,
      subsystems,
      scheduleRevealForDetonation,
    };
  }, [fullLog, revealedIds, unit, scheduleRevealForDetonation]);
}
