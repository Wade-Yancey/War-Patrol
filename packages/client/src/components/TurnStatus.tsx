import type { TurnState } from '@war-patrol/shared';
import { memo, useEffect, useState } from 'react';

function formatRemaining(deadline: string, now: number): string {
  const ms = Date.parse(deadline) - now;
  if (ms <= 0) return '00:00';
  const s = Math.ceil(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function TurnStatusInner({ turn }: { turn: TurnState }) {
  const active = Boolean(turn.timerDeadline && turn.phase === 'open');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, turn.timerDeadline]);

  const remaining = active && turn.timerDeadline ? formatRemaining(turn.timerDeadline, now) : null;

  return (
    <div className="row" style={{ alignItems: 'center', gap: '0.75rem' }}>
      <span className="mono">Turn {turn.number}</span>
      <span className={`status-pill ${turn.phase}`}>{turn.phase.replace('_', ' ')}</span>
      {remaining && (
        <span className="mono muted" aria-live="polite">
          Timer {remaining}
        </span>
      )}
    </div>
  );
}

export const TurnStatus = memo(TurnStatusInner);
