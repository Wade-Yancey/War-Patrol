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
}

function clampOrWrap(n: number, min: number, max: number, wrap: boolean): number {
  if (wrap) {
    const span = max - min + 1;
    let v = ((n - min) % span + span) % span + min;
    return v;
  }
  return Math.min(max, Math.max(min, n));
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
}: TouchNumberProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      setEditing(false);
      return;
    }
    onChange(clampOrWrap(Math.round(n / step) * step, min, max, wrap));
    setEditing(false);
  };

  const nudge = (dir: -1 | 1) => {
    if (disabled) return;
    onChange(clampOrWrap(value + dir * step, min, max, wrap));
  };

  const display = format ? format(value) : `${value}${unit ? ` ${unit}` : ''}`;

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
                  setDraft(String(value));
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
      <p className="touch-num-hint">Tap readout to type · {min}–{max}{unit ? ` ${unit}` : ''}</p>
    </div>
  );
}
