import type { TurnState } from '@war-patrol/shared';
import { formatGameClock } from '@war-patrol/shared';
import { memo, useEffect, useState } from 'react';

const URGENT_SECONDS = 30;
const CRITICAL_SECONDS = 10;

function remainingSeconds(deadline: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
}

function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
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

  const secsLeft =
    active && turn.timerDeadline ? remainingSeconds(turn.timerDeadline, now) : null;
  const remaining = secsLeft != null ? formatMmSs(secsLeft) : null;
  const urgency =
    secsLeft == null
      ? null
      : secsLeft <= CRITICAL_SECONDS
        ? 'critical'
        : secsLeft <= URGENT_SECONDS
          ? 'urgent'
          : 'nominal';

  const gameClock =
    typeof turn.gameTimeSeconds === 'number' ? formatGameClock(turn.gameTimeSeconds) : null;
  const lengthMin =
    typeof turnLengthSeconds === 'number' && turnLengthSeconds > 0
      ? turnLengthSeconds / 60
      : null;

  return (
    <div className="turn-status" role="group" aria-label="Turn status">
      <div
        className={[
          'turn-chronometer',
          active ? 'is-running' : 'is-idle',
          urgency ? `is-${urgency}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="turn-chronometer-label">
          {active ? 'Order time' : turn.phase === 'open' ? 'No timer' : 'Orders closed'}
        </span>
        <span className="turn-chronometer-digits mono">
          {remaining ?? (turn.phase === 'open' ? '--:--' : '——')}
        </span>
      </div>

      <div className="turn-status-meta">
        <span className="mono turn-status-turn">Turn {turn.number}</span>
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
      </div>
    </div>
  );
}

export const TurnStatus = memo(TurnStatusInner);
