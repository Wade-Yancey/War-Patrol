import { useMemo, useRef, useEffect } from 'react';
import { formatGameClock, type CombatLogEntry } from '@war-patrol/shared';

interface Props {
  entries: CombatLogEntry[];
}

function kindLabel(kind: CombatLogEntry['kind']): string {
  switch (kind) {
    case 'torpedo_launch':
      return 'TORP FIRE';
    case 'torpedo_hit':
      return 'TORP HIT';
    case 'torpedo_miss':
      return 'TORP MISS';
    case 'torpedo_expired':
      return 'TORP END';
    case 'depth_charge_drop':
      return 'DC DROP';
    case 'depth_charge_detonation':
      return 'DC DET';
    case 'depth_charge_damage':
      return 'DC DMG';
    case 'unit_sunk':
      return 'SUNK';
    case 'subsystem_casualty':
      return 'CASUALTY';
    default:
      return 'EVENT';
  }
}

/**
 * Compact umpire CRT action / damage log — chronological, newest at bottom.
 * Rendered below the full-width GT map (not beside it).
 */
export function CombatLogPanel({ entries }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => [...entries], [entries]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [sorted.length]);

  return (
    <div className="stack umpire-combat-log" aria-label="Action and damage log">
      <div className="umpire-combat-log-head">
        <h2>Action log</h2>
        <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          Weapon launches, detonations, hits, and damage — umpire GT only. Below the map so the
          plot stays full-width.
        </p>
      </div>
      <div className="umpire-combat-log-list mono" ref={listRef} role="log" aria-live="polite">
        {sorted.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            No combat events yet. Resolve a turn with weapons queued to populate.
          </p>
        ) : (
          <ul>
            {sorted.map((e) => (
              <li key={e.id} className={`combat-log-line combat-log-line--${e.kind}`}>
                <span className="combat-log-meta">
                  T{e.turnNumber} · {formatGameClock(e.gameTimeSeconds)} · {kindLabel(e.kind)}
                </span>
                <span className="combat-log-summary readout">{e.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
