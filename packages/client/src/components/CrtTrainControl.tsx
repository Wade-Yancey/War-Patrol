import { useCallback, useEffect, useRef, type PointerEvent } from 'react';

/** Delay before continuous hold-repeat starts (ms). */
export const TRAIN_HOLD_DELAY_MS = 400;
/** Tick interval while ◀ / ▶ are held (ms) — ~12.5 steps/s. */
export const TRAIN_HOLD_INTERVAL_MS = 80;

interface Props {
  /** Aux-panel caption above the button pair. */
  label: string;
  /** Called per step with the direction; hold repeats the call. */
  onNudge: (dir: -1 | 1) => void;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
}

/**
 * Shared CRT train pair (◀ / ▶) with hold-repeat — hydrophone listen bearing and
 * helm course use the same treatment and scale. Click / hold only; no slider.
 */
export function CrtTrainControl({
  label,
  onNudge,
  decreaseLabel,
  increaseLabel,
  disabled = false,
}: Props) {
  const holdDelayRef = useRef<number | null>(null);
  const holdIntervalRef = useRef<number | null>(null);

  const stopHold = useCallback(() => {
    if (holdDelayRef.current != null) {
      window.clearTimeout(holdDelayRef.current);
      holdDelayRef.current = null;
    }
    if (holdIntervalRef.current != null) {
      window.clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  }, []);

  useEffect(() => stopHold, [stopHold]);

  useEffect(() => {
    if (disabled) stopHold();
  }, [disabled, stopHold]);

  const startHold = (dir: -1 | 1) => (e: PointerEvent<HTMLButtonElement>) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    // Capture so hold-repeat continues if the pointer slides off the hit target.
    e.currentTarget.setPointerCapture(e.pointerId);
    stopHold();
    onNudge(dir);
    holdDelayRef.current = window.setTimeout(() => {
      holdDelayRef.current = null;
      holdIntervalRef.current = window.setInterval(() => {
        onNudge(dir);
      }, TRAIN_HOLD_INTERVAL_MS);
    }, TRAIN_HOLD_DELAY_MS);
  };

  const endHold = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    stopHold();
  };

  return (
    <div className="crt-train">
      <span className="crt-console-key crt-train-key">{label}</span>
      <div className="crt-train-row">
        <button
          type="button"
          className="crt-train-nudge"
          disabled={disabled}
          aria-label={decreaseLabel}
          onPointerDown={startHold(-1)}
          onPointerUp={endHold}
          onPointerCancel={endHold}
          onLostPointerCapture={stopHold}
          onClick={(e) => {
            /* Keyboard activation only — pointer path already nudged on down. */
            if (e.detail === 0) onNudge(-1);
          }}
        >
          ◀
        </button>
        <button
          type="button"
          className="crt-train-nudge"
          disabled={disabled}
          aria-label={increaseLabel}
          onPointerDown={startHold(1)}
          onPointerUp={endHold}
          onPointerCancel={endHold}
          onLostPointerCapture={stopHold}
          onClick={(e) => {
            if (e.detail === 0) onNudge(1);
          }}
        >
          ▶
        </button>
      </div>
    </div>
  );
}
