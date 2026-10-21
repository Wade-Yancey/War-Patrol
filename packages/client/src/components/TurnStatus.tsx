import type { TurnPhase, TurnState } from '@war-patrol/shared';
import { formatGameClock } from '@war-patrol/shared';
import { memo, useEffect, useState } from 'react';

const URGENT_SECONDS = 30;
const CRITICAL_SECONDS = 10;

/**
 * Whole seconds left until deadline. Uses ceil so a partial second still
 * counts as 1. Cap at `maxSeconds` (configured duration) so a stale client
 * `now` or mild clock skew cannot flash above the armed length (e.g. 3:02
 * right after Start 3m).
 */
function remainingSeconds(deadline: string, now: number, maxSeconds?: number): number {
  const raw = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  if (typeof maxSeconds === 'number' && maxSeconds > 0) {
    return Math.min(raw, maxSeconds);
  }
  return raw;
}

function formatMmSs(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function phaseLabel(phase: TurnPhase): string {
  if (phase === 'awaiting_resolution') return 'resolve ready';
  return phase;
}

/**
 * Chronometer modes for umpire + stations:
 * - running: open + future deadline
 * - expired: open + deadline in the past (auto-lock in flight)
 * - paused: open + no deadline (manual lock / Stop)
 * - closed: locked or awaiting_resolution
 */
function chronometerMode(
  turn: TurnState,
  secsLeft: number | null,
): 'running' | 'expired' | 'paused' | 'closed' {
  if (turn.phase !== 'open') return 'closed';
  if (!turn.timerDeadline) return 'paused';
  if (secsLeft != null && secsLeft <= 0) return 'expired';
  return 'running';
}

function chronometerLabel(mode: ReturnType<typeof chronometerMode>): string {
  switch (mode) {
    case 'running':
      return 'Order time';
    case 'expired':
      return 'Expired';
    case 'paused':
      return 'No timer';
    case 'closed':
      return 'Orders closed';
  }
}

function TurnStatusInner({
  turn,
  turnLengthSeconds,
}: {
  turn: TurnState;
  turnLengthSeconds?: number;
}) {
  const hasDeadline = Boolean(turn.timerDeadline && turn.phase === 'open');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasDeadline) return;
    // Refresh immediately — while paused, `now` is not ticked, so the first
    // paint after Start would otherwise use a stale mount/last-tick clock and
    // Math.ceil would show ~2s over (3:02 for a 180s arm).
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasDeadline, turn.timerDeadline]);

  const secsLeft =
    hasDeadline && turn.timerDeadline
      ? remainingSeconds(turn.timerDeadline, now, turn.timerSeconds)
      : null;
  const mode = chronometerMode(turn, secsLeft);
  const remaining = secsLeft != null ? formatMmSs(secsLeft) : null;
  const urgency =
    mode !== 'running' || secsLeft == null
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

  const digits =
    mode === 'running' || mode === 'expired'
      ? (remaining ?? '00:00')
      : mode === 'paused'
        ? '--:--'
        : '——';

  return (
    <div className="turn-status" role="group" aria-label="Turn status">
      <div
        className={[
          'turn-chronometer',
          mode === 'running' ? 'is-running' : 'is-idle',
          mode === 'expired' ? 'is-expired' : '',
          urgency ? `is-${urgency}` : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="turn-chronometer-label">{chronometerLabel(mode)}</span>
        <span className="turn-chronometer-digits mono">{digits}</span>
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
        <span className={`status-pill ${turn.phase}`}>{phaseLabel(turn.phase)}</span>
      </div>
    </div>
  );
}

export const TurnStatus = memo(TurnStatusInner);
