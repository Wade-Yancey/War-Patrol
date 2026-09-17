import type { TurnState } from '@war-patrol/shared';
import { useEffect, useState } from 'react';

export function TurnStatus({ turn }: { turn: TurnState }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  let remaining: string | null = null;
  if (turn.timerDeadline && turn.phase === 'open') {
    const ms = Date.parse(turn.timerDeadline) - now;
    if (ms <= 0) remaining = '00:00';
    else {
      const s = Math.ceil(ms / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      remaining = `${mm}:${ss}`;
    }
  }

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
