import { useEffect, useMemo, useRef } from 'react';
import {
  conditionLabel,
  formatGameClock,
  type OwnDamageEvent,
  type UnitCondition,
  type UnitSubsystems,
  type VesselType,
} from '@war-patrol/shared';

interface Props {
  vesselName: string;
  vesselType: VesselType;
  health: number;
  condition: UnitCondition;
  subsystems: UnitSubsystems;
  damageLog?: OwnDamageEvent[];
}

function kindLabel(kind: OwnDamageEvent['kind']): string {
  switch (kind) {
    case 'torpedo_hit':
      return 'TORP HIT';
    case 'depth_charge_damage':
      return 'DC SHOCK';
    case 'unit_sunk':
      return 'SUNK';
    case 'subsystem_casualty':
      return 'CASUALTY';
    default:
      return 'EVENT';
  }
}

function subsystemLabel(state: UnitSubsystems[keyof UnitSubsystems]): string {
  return state === 'disabled' ? 'DISABLED' : 'INTACT';
}

/**
 * Own-ship FoW damage report for Controls — hull integrity, subsystems,
 * and chronological damage taken (never the enemy board).
 */
export function DamageReportPanel({
  vesselName,
  vesselType,
  health,
  condition,
  subsystems,
  damageLog = [],
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => [...damageLog], [damageLog]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const healthPct = Math.max(0, Math.min(100, Math.round(health)));
  const hullBad = condition === 'sunk' || healthPct < 35;
  const hullWarn = !hullBad && healthPct < 70;

  return (
    <section className="panel stack controls-damage-panel" aria-label="Damage report">
      <div className="controls-section-head">
        <h2>Damage report</h2>
        <p className="muted controls-section-blurb">
          Own ship only — hull integrity and subsystem status known to {vesselName}. Not the enemy
          damage board.
        </p>
      </div>

      <div className="damage-status-grid mono">
        <div className="damage-status-item">
          <span className="controls-status-key">HULL</span>
          <span
            className={`readout${hullBad ? ' damage-bad' : hullWarn ? ' damage-warn' : ''}`}
          >
            {healthPct}% · {conditionLabel(vesselType, condition)}
          </span>
          <div
            className="damage-health-bar"
            role="meter"
            aria-valuenow={healthPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Hull integrity"
          >
            <div
              className={`damage-health-fill${hullBad ? ' damage-health-fill--bad' : hullWarn ? ' damage-health-fill--warn' : ''}`}
              style={{ width: `${healthPct}%` }}
            />
          </div>
        </div>
        <div className="damage-status-item">
          <span className="controls-status-key">PROPULSION</span>
          <span
            className={`readout${subsystems.propulsion === 'disabled' ? ' damage-bad' : ''}`}
          >
            {subsystemLabel(subsystems.propulsion)}
          </span>
        </div>
        <div className="damage-status-item">
          <span className="controls-status-key">SENSORS</span>
          <span
            className={`readout${subsystems.sensors === 'disabled' ? ' damage-bad' : ''}`}
          >
            {subsystemLabel(subsystems.sensors)}
          </span>
        </div>
      </div>

      <div className="damage-log-block">
        <h3 className="damage-log-title">Damage taken</h3>
        <div className="damage-log-list mono" ref={listRef} role="log" aria-live="polite">
          {entries.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
              No combat damage recorded against this hull yet.
            </p>
          ) : (
            <ul>
              {entries.map((e) => (
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
    </section>
  );
}
