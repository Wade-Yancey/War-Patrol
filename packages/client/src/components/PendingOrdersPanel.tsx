import {
  EOT_LABELS,
  factionAccent,
  formatCourseDegrees,
  pendingOrderRows,
  type UnitState,
} from '@war-patrol/shared';
import { memo, useMemo } from 'react';

function formatUpdatedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return null;
  }
}

function PendingOrdersPanelInner({ units }: { units: UnitState[] }) {
  const rows = useMemo(() => pendingOrderRows(units), [units]);
  const filed = rows.filter((r) => r.submitted).length;
  const total = rows.length;

  return (
    <section className="panel stack pending-orders-panel" aria-label="Pending orders of record">
      <div className="pending-orders-head">
        <h2>Pending orders of record</h2>
        <span
          className={`status-pill ${filed === total && total > 0 ? 'open' : 'awaiting_resolution'}`}
          title="Vessels with helm and/or engine orders filed for this turn"
        >
          {filed}/{total} filed
        </span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: '0.8rem' }}>
        Live submissions for the current turn. CRS rings up immediately; engine orders apply on
        Resolve. Gaps sort to the top.
      </p>
      {total === 0 ? (
        <p className="muted mono" style={{ margin: 0 }}>
          No vessels in play.
        </p>
      ) : (
        <div className="pending-orders-list" role="list">
          {rows.map((row) => {
            const accent = factionAccent(row.faction);
            const clock = formatUpdatedAt(row.updatedAt);
            return (
              <div
                key={row.unitId}
                className={`pending-order-row pending-order-row--${row.submitted ? 'in' : 'out'}`}
                role="listitem"
              >
                <span className={`faction-stripe faction-stripe--${accent}`} aria-hidden />
                <div className="pending-order-main">
                  <div className="pending-order-id">
                    <span className="readout">{row.name}</span>
                    <span className="mono muted">{row.unitId}</span>
                  </div>
                  <div className="pending-order-status">
                    <span
                      className={`status-pill ${row.submitted ? 'open' : 'awaiting_resolution'}`}
                    >
                      {row.submitted ? 'Submitted' : 'None'}
                    </span>
                    <span className="mono readout pending-order-summary">{row.summary}</span>
                  </div>
                  <div className="pending-order-meta mono muted">
                    <span>
                      Standing CRS {formatCourseDegrees(row.orderedCourse)} · Engine orders{' '}
                      {EOT_LABELS[row.currentEot]}
                    </span>
                    {row.submitted && (row.updatedByStationId || clock) && (
                      <span>
                        {row.updatedByStationId ? `via ${row.updatedByStationId}` : null}
                        {row.updatedByStationId && clock ? ' · ' : null}
                        {clock}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export const PendingOrdersPanel = memo(PendingOrdersPanelInner);
