import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultSubsystems,
  presentationHealthFromUnrevealedDamage,
  presentationSubsystemsFromUnrevealed,
  type OwnDamageEvent,
  type UnitCondition,
  type UnitSubsystems,
  type VesselView,
} from '@war-patrol/shared';
import { depthChargeBatchWhenSecById } from '../audio/depthCharge';
import { torpedoHitBatchWhenSecById } from '../audio/torpedoHit';

export type ScheduleDamageReveal = (detonationId: string, whenSec: number) => void;

export type SyncedDamagePresentation = {
  damageLog: OwnDamageEvent[];
  health: number;
  condition: UnitCondition;
  subsystems: UnitSubsystems;
  /** Register from Controls bridge audio flush so reveals share `whenSec`. */
  scheduleRevealForDetonation: ScheduleDamageReveal;
  /**
   * Bridge hit cues filtered to detonations whose reveal timer has fired.
   * Firer “TORPEDO HIT / DEPTH CHARGE” BRIDGE lines use this — not raw cues.
   */
  visibleBridgeDetonations: NonNullable<VesselView['bridgeDetonations']>;
};

/**
 * Stage Controls Damage-report UI (and firer BRIDGE hit lines) until the
 * matching bridge blast SFX plays.
 *
 * Sim / vessel health stay at resolve-time truth; only presentation is held.
 * Entries without a live `bridgeDetonations` cue (or no `sourceDetonationId`)
 * reveal immediately. DC cues use the pattern stagger `whenSec`; torpedo-hit
 * cues use `audioDelaySec` (arrival inside the resolved turn) plus a short
 * same-moment multi-hit stagger so bangs stay countable. Umpire Action log is
 * untouched.
 *
 * Reveals are scheduled from live `bridgeDetonations` (Sensors + Controls) and
 * again from Controls audio flush — first schedule wins (idempotent).
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
  const [revealedDetonationIds, setRevealedDetonationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const fullLogRef = useRef(fullLog);
  fullLogRef.current = fullLog;
  const timersRef = useRef<number[]>([]);
  /** Detonation ids already given a reveal timer (or revealed at once). */
  const scheduledDetonationIdsRef = useRef<Set<string>>(new Set());

  const revealDetonation = useCallback((detonationId: string) => {
    setRevealedDetonationIds((prev) => {
      if (prev.has(detonationId)) return prev;
      const next = new Set(prev);
      next.add(detonationId);
      return next;
    });
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
      if (scheduledDetonationIdsRef.current.has(detonationId)) return;
      scheduledDetonationIdsRef.current.add(detonationId);
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

  // Auto-schedule from live bridge cues (Sensors has no audio flush; Controls
  // flush may also call schedule — first wins via scheduledDetonationIdsRef).
  useEffect(() => {
    const events = bridgeDetonations ?? [];
    const liveIds = new Set(events.map((d) => d.id));
    for (const id of [...scheduledDetonationIdsRef.current]) {
      if (!liveIds.has(id)) scheduledDetonationIdsRef.current.delete(id);
    }
    setRevealedDetonationIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of [...next]) {
        if (!liveIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const dcBatch = events.filter(
      (e) => e.kind !== 'torpedo_hit' && e.kind !== 'aircraft_bomb',
    );
    const dcWhenById = depthChargeBatchWhenSecById(dcBatch);
    const hitBatch = events.filter((e) => e.kind === 'torpedo_hit');
    const hitWhenById = torpedoHitBatchWhenSecById(hitBatch);
    for (const e of events) {
      if (scheduledDetonationIdsRef.current.has(e.id)) continue;
      let whenSec = 0;
      if (e.kind === 'torpedo_hit') {
        whenSec = hitWhenById.get(e.id) ?? Math.max(0, e.audioDelaySec ?? 0);
      } else if (e.kind === 'aircraft_bomb') {
        whenSec = Math.max(0, e.audioDelaySec ?? 0);
      } else {
        whenSec = dcWhenById.get(e.id) ?? 0;
      }
      scheduleRevealForDetonation(e.id, whenSec);
    }
  }, [bridgeDetonations, scheduleRevealForDetonation]);

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
    const visibleBridgeDetonations = (bridgeDetonations ?? []).filter((d) =>
      revealedDetonationIds.has(d.id),
    );

    if (!unit) {
      return {
        damageLog: log.filter((e) => revealedIds.has(e.id)),
        health: 100,
        condition: 'afloat' as const,
        subsystems: defaultSubsystems(),
        scheduleRevealForDetonation,
        visibleBridgeDetonations,
      };
    }

    const damageLog = log.filter((e) => revealedIds.has(e.id));
    const held = log.filter((e) => !revealedIds.has(e.id));

    const health = presentationHealthFromUnrevealedDamage(unit.health, held);

    const heldFatal = held.some((e) => e.kind === 'unit_sunk' || e.kind === 'hull_implosion');
    // Keep afloat while a linked fatal line is still waiting on its blast cue.
    const condition: UnitCondition = heldFatal || health > 0 ? 'afloat' : 'sunk';

    const subsystems = presentationSubsystemsFromUnrevealed(unit.subsystems, held);

    return {
      damageLog,
      health,
      condition,
      subsystems,
      scheduleRevealForDetonation,
      visibleBridgeDetonations,
    };
  }, [
    fullLog,
    bridgeDetonations,
    revealedIds,
    revealedDetonationIds,
    unit,
    scheduleRevealForDetonation,
  ]);
}
