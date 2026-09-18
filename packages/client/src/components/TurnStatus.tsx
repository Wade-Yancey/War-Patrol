import type { TurnState } from '@war-patrol/shared';
import { formatGameClock } from '@war-patrol/shared';
import { memo, useEffect, useState } from 'react';

function formatRemaining(deadline: string, now: number): string {
  const ms = Date.parse(deadline) - now;
  if (ms <= 0) return '00:00';
  const s = Math.ceil(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function TurnStatusInner({
  turn,
  turnLengthSeconds,
}: {
  turn: TurnState;
  turnLengthSeconds?: number;
}) {
  const active = Boolean(turn.timerDeadline && turn.phase === 'open');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active, turn.timerDeadline]);

  const remaining = active && turn.timerDeadline ? formatRemaining(turn.timerDeadline, now) : null;
  const gameClock =
    typeof turn.gameTimeSeconds === 'number' ? formatGameClock(turn.gameTimeSeconds) : null;
  const lengthMin =
    typeof turnLengthSeconds === 'number' && turnLengthSeconds > 0
      ? turnLengthSeconds / 60
      : null;

  return (
    <div className="row" style={{ alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
      <span className="mono">Turn {turn.number}</span>
      {gameClock && (
        <span className="mono readout" title="In-game clock">
          ZULU {gameClock}
        </span>
      )}
      {lengthMin != null && (
        <span className="mono muted" title="In-game minutes per turn">
          +{Number.isInteger(lengthMin) ? lengthMin : lengthMin.toFixed(1)} min/turn
        </span>
      )}
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
