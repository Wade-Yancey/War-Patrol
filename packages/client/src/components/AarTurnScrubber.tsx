import { memo, useMemo } from 'react';
import { formatGameClock, type TurnSnapshot } from '@war-patrol/shared';

/**
 * Umpire AAR turn scrubber — read-only flip through history snapshots.
 * Does not mutate live state (unlike destructive rollback).
 */
function AarTurnScrubberInner({
  historySnapshots,
  liveTurnNumber,
  reviewTurn,
  onReviewTurn,
}: {
  historySnapshots: TurnSnapshot[];
  /** Current open / live turn number (next after last resolve). */
  liveTurnNumber: number;
  /** null = LIVE; otherwise end-of-resolve turn being reviewed. */
  reviewTurn: number | null;
  onReviewTurn: (turn: number | null) => void;
}) {
  const sorted = useMemo(
    () => [...historySnapshots].sort((a, b) => a.turnNumber - b.turnNumber),
    [historySnapshots],
  );
  const numbers = useMemo(() => sorted.map((s) => s.turnNumber), [sorted]);
  const minTurn = numbers[0] ?? 0;
  const maxTurn = numbers[numbers.length - 1] ?? 0;
  const reviewing = reviewTurn != null;
  const activeSnap = reviewing
    ? sorted.find((s) => s.turnNumber === reviewTurn) ?? null
    : null;

  if (numbers.length === 0) {
    return (
      <div className="aar-scrubber aar-scrubber--empty" aria-label="After-action review">
        <span className="aar-mode-pill aar-mode-pill--live" title="Live game state">
          LIVE
        </span>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Resolve turns to scrub history for AAR
        </span>
      </div>
    );
  }

  const idx = reviewing ? numbers.indexOf(reviewTurn) : -1;
  const canPrev = reviewing ? idx > 0 : numbers.length > 0;
  const canNext = reviewing ? idx >= 0 && idx < numbers.length - 1 : false;

  const goPrev = () => {
    if (!reviewing) {
      onReviewTurn(maxTurn);
      return;
    }
    if (idx > 0) onReviewTurn(numbers[idx - 1]!);
  };

  const goNext = () => {
    if (!reviewing || idx < 0) return;
    if (idx < numbers.length - 1) onReviewTurn(numbers[idx + 1]!);
    else onReviewTurn(null);
  };

  const clock =
    activeSnap && typeof activeSnap.gameTimeSeconds === 'number'
      ? formatGameClock(activeSnap.gameTimeSeconds)
      : null;

  return (
    <div className="aar-scrubber" role="group" aria-label="After-action review turn scrubber">
      <div className="aar-scrubber-mode">
        {reviewing ? (
          <span
            className="aar-mode-pill aar-mode-pill--review"
            title="Read-only view of a prior resolve — live Resolve still advances the game"
          >
            REVIEW · end of T{reviewTurn}
          </span>
        ) : (
          <span className="aar-mode-pill aar-mode-pill--live" title="Live game state">
            LIVE · T{liveTurnNumber}
          </span>
        )}
        {clock && reviewing && (
          <span className="mono muted" style={{ fontSize: '0.8rem' }}>
            ZULU {clock}
          </span>
        )}
      </div>

      <div className="aar-scrubber-controls">
        <button type="button" disabled={!canPrev} onClick={goPrev} aria-label="Previous turn">
          ← Prev
        </button>
        <label className="aar-scrubber-slider">
          <span className="visually-hidden">Review turn</span>
          <input
            type="range"
            min={minTurn}
            max={maxTurn}
            step={1}
            value={reviewing ? reviewTurn : maxTurn}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              onReviewTurn(n);
            }}
            aria-valuemin={minTurn}
            aria-valuemax={maxTurn}
            aria-valuenow={reviewing ? reviewTurn : maxTurn}
            aria-label="Turn history slider"
          />
          <span className="mono aar-scrubber-range-label">
            T{minTurn}–T{maxTurn}
          </span>
        </label>
        <button
          type="button"
          disabled={!canNext && reviewing}
          onClick={goNext}
          aria-label={reviewing && idx === numbers.length - 1 ? 'Return to live' : 'Next turn'}
        >
          Next →
        </button>
        <button
          type="button"
          className={reviewing ? 'primary' : undefined}
          disabled={!reviewing}
          onClick={() => onReviewTurn(null)}
          aria-label="Return to live view"
        >
          Live
        </button>
      </div>
    </div>
  );
}

export const AarTurnScrubber = memo(AarTurnScrubberInner);
