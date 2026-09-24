import { useEffect, useId, useRef, useState } from 'react';

export interface TouchNumberProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Wrap at min/max (e.g. course 0–359). */
  wrap?: boolean;
  unit?: string;
  disabled?: boolean;
  /** Show range slider under steppers. Default true when span is useful. */
  showSlider?: boolean;
  format?: (value: number) => string;
  /** Parse typed readout text; when set, draft uses `format` (or String) instead of raw number. */
  parse?: (raw: string) => number | null;
  /** Override the default min–max range hint. */
  hint?: string;
}

function clampOrWrap(n: number, min: number, max: number, wrap: boolean): number {
  if (wrap) {
    const span = max - min + 1;
    let v = ((n - min) % span + span) % span + min;
    return v;
  }
  return Math.min(max, Math.max(min, n));
}

/** Decimal places implied by a step like `0.1` or `0.01` (0 for whole steps). */
function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Snap to the step's own decimal precision. Repeated +/- nudges or a typed
 * value divided/multiplied by a fractional step (e.g. 0.1, 0.01) reliably
 * reintroduce binary-float noise (0.1 + 0.2 -> 0.30000000000000004); without
 * this, fine-grained controls would drift and display ugly long decimals.
 */
function snapToStep(n: number, step: number): number {
  const decimals = stepDecimals(step);
  if (decimals === 0) return n;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Large +/- / slider numeric control; typed entry is optional (tap readout). */
export function TouchNumber({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  wrap = false,
  unit = '',
  disabled = false,
  showSlider = true,
  format,
  parse,
  hint,
}: TouchNumberProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const draftText = (n: number) => (format && parse ? format(n) : String(n));
  const [draft, setDraft] = useState(() => draftText(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(draftText(value));
  }, [value, editing, format, parse]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = (raw: string) => {
    const n = parse ? parse(raw) : Number(raw);
    if (n == null || !Number.isFinite(n)) {
      setDraft(draftText(value));
      setEditing(false);
      return;
    }
    const snapped = snapToStep(Math.round(n / step) * step, step);
    onChange(clampOrWrap(snapped, min, max, wrap));
    setEditing(false);
  };

  const nudge = (dir: -1 | 1) => {
    if (disabled) return;
    onChange(clampOrWrap(snapToStep(value + dir * step, step), min, max, wrap));
  };

  const display = format ? format(value) : `${value}${unit ? ` ${unit}` : ''}`;
  const defaultHint = `${min}–${max}${unit ? ` ${unit}` : ''}`;

  return (
    <div className="touch-num">
      <label htmlFor={id}>{label}</label>
      <div className="touch-num-main">
        <button
          type="button"
          className="hit-lg"
          aria-label={`Decrease ${label}`}
          disabled={disabled || (!wrap && value <= min)}
          onClick={() => nudge(-1)}
        >
          −
        </button>
        <div
          className={`touch-num-value${editing ? ' editing' : ''}`}
          role={editing ? undefined : 'button'}
          tabIndex={editing || disabled ? undefined : 0}
          onClick={() => {
            if (!disabled && !editing) setEditing(true);
          }}
          onKeyDown={(e) => {
            if (!editing && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              setEditing(true);
            }
          }}
          aria-label={`${label} ${display}. Tap to type.`}
        >
          {editing ? (
            <input
              id={id}
              ref={inputRef}
              inputMode="numeric"
              type="text"
              value={draft}
              disabled={disabled}
              aria-label={`Type ${label}`}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit(draft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit(draft);
                }
                if (e.key === 'Escape') {
                  setDraft(draftText(value));
                  setEditing(false);
                }
              }}
            />
          ) : (
            display
          )}
        </div>
        <button
          type="button"
          className="hit-lg"
          aria-label={`Increase ${label}`}
          disabled={disabled || (!wrap && value >= max)}
          onClick={() => nudge(1)}
        >
          +
        </button>
      </div>
      {showSlider && (
        <input
          className="touch-num-slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={`${label} slider`}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}
      <p className="touch-num-hint">{hint ?? defaultHint}</p>
    </div>
  );
}
