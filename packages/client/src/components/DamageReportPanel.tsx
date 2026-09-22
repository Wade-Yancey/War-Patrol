import { useEffect, useMemo, useRef } from 'react';
import {
  conditionLabel,
  formatGameClock,
  subsystemStateLabel,
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
    case 'hull_implosion':
      return 'IMPLODED';
    case 'subsystem_casualty':
      return 'CASUALTY';
    default:
      return 'EVENT';
  }
}

function isBad(state: string): boolean {
  return state !== 'intact';
}

/**
 * Own-ship FoW damage report for Controls — hull integrity, subsystems,
 * and chronological damage taken (never the enemy board).
 *
 * Callers may pass audio-staged health / log lines so DC shock reports appear
 * with the matching explosion cue rather than all at once on turn resolve.
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

  const steeringLabel =
    subsystems.steering === 'stuck' && subsystems.rudderStuckHeading != null
      ? `STUCK ${String(Math.round(subsystems.rudderStuckHeading)).padStart(3, '0')}°`
      : subsystemStateLabel(subsystems.steering);

  const diveLabel =
    (subsystems.divePlanes === 'stuck' || subsystems.divePlanes === 'disabled') &&
    subsystems.divePlanesStuckDepth != null
      ? `${subsystemStateLabel(subsystems.divePlanes)} ${Math.round(subsystems.divePlanesStuckDepth)} m`
      : subsystemStateLabel(subsystems.divePlanes);

  return (
    <section className="panel stack controls-damage-panel station-instrument-panel" aria-label="Damage report">
      <div className="station-instrument-head">
        <h2>Damage report</h2>
        <p className="muted station-instrument-blurb">{vesselName} — own ship only</p>
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
          <span className={`readout${isBad(subsystems.propulsion) ? ' damage-bad' : ''}`}>
            {subsystemStateLabel(subsystems.propulsion)}
          </span>
        </div>
        <div className="damage-status-item">
          <span className="controls-status-key">STEERING</span>
          <span className={`readout${isBad(subsystems.steering) ? ' damage-bad' : ''}`}>
            {steeringLabel}
          </span>
        </div>
        {vesselType === 'Submarine' && (
          <div className="damage-status-item">
            <span className="controls-status-key">DIVE PLANES</span>
            <span className={`readout${isBad(subsystems.divePlanes) ? ' damage-bad' : ''}`}>
              {diveLabel}
            </span>
          </div>
        )}
        <div className="damage-status-item">
          <span className="controls-status-key">RADAR</span>
          <span className={`readout${isBad(subsystems.radar) ? ' damage-bad' : ''}`}>
            {subsystemStateLabel(subsystems.radar)}
          </span>
        </div>
        {vesselType === 'Submarine' ? (
          <>
            <div className="damage-status-item">
              <span className="controls-status-key">HYDROPHONE</span>
              <span className={`readout${isBad(subsystems.hydrophone) ? ' damage-bad' : ''}`}>
                {subsystemStateLabel(subsystems.hydrophone)}
              </span>
            </div>
            <div className="damage-status-item">
              <span className="controls-status-key">PERISCOPE</span>
              <span className={`readout${isBad(subsystems.lookout) ? ' damage-bad' : ''}`}>
                {subsystemStateLabel(subsystems.lookout)}
              </span>
            </div>
          </>
        ) : (
          <div className="damage-status-item">
            <span className="controls-status-key">ACTIVE SONAR</span>
            <span className={`readout${isBad(subsystems.activeSonar) ? ' damage-bad' : ''}`}>
              {subsystemStateLabel(subsystems.activeSonar)}
            </span>
          </div>
        )}
      </div>

      <div className="damage-log-block">
        <h3 className="damage-log-title">Damage taken</h3>
        <div className="damage-log-list mono" ref={listRef} role="log" aria-live="polite">
          {entries.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
              No damage recorded.
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
