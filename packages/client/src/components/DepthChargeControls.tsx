import { useState } from 'react';
import {
  DEPTH_CHARGE_DEFAULT_DEPTH_M,
  DEPTH_CHARGE_MAX_DEPTH_M,
  DEPTH_CHARGE_MIN_DEPTH_M,
  depthChargePatternCount,
  type DepthChargeDropOrder,
  type DepthChargePattern,
  type DepthChargeTrack,
} from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

interface Props {
  depthChargeLoad: number;
  pending?: DepthChargeDropOrder;
  tracks?: DepthChargeTrack[];
  disabled?: boolean;
  onSubmit: (order: DepthChargeDropOrder) => void;
  onClear?: () => void;
}

const PATTERNS: Array<{ id: DepthChargePattern; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'pair', label: 'Pair' },
  { id: 'pattern_3', label: 'Pattern 3' },
  { id: 'pattern_5', label: 'Pattern 5' },
];

/** Destroyer depth-charge drop panel — pattern + depth setting. */
export function DepthChargeControls({
  depthChargeLoad,
  pending,
  tracks = [],
  disabled,
  onSubmit,
  onClear,
}: Props) {
  const [pattern, setPattern] = useState<DepthChargePattern>(
    () => pending?.pattern ?? 'pattern_3',
  );
  const [depthSettingM, setDepthSettingM] = useState(
    () => pending?.depthSettingM ?? DEPTH_CHARGE_DEFAULT_DEPTH_M,
  );

  const need = depthChargePatternCount(pattern);
  const canDrop = depthChargeLoad >= need;

  return (
    <section className="panel stack controls-weapons-panel">
      <div className="controls-section-head">
        <h2>Depth charges</h2>
        <p className="muted controls-section-blurb">
          Rack load {depthChargeLoad}. Pattern consumes charges on resolve. Set depth from sonar
          estimate — match vs target keel drives effect.
        </p>
      </div>

      <fieldset className="weapons-plot-fieldset" disabled={disabled || depthChargeLoad <= 0}>
        <legend className="mono">Pattern</legend>
        <div className="weapons-plot-row">
          {PATTERNS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={pattern === p.id ? 'primary' : undefined}
              aria-pressed={pattern === p.id}
              onClick={() => setPattern(p.id)}
            >
              {p.label} ({depthChargePatternCount(p.id)})
            </button>
          ))}
        </div>
      </fieldset>

      <TouchNumber
        label="Depth setting"
        value={depthSettingM}
        onChange={setDepthSettingM}
        min={DEPTH_CHARGE_MIN_DEPTH_M}
        max={DEPTH_CHARGE_MAX_DEPTH_M}
        step={5}
        unit="m"
        disabled={disabled || depthChargeLoad <= 0}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={disabled || !canDrop}
          onClick={() => onSubmit({ pattern, depthSettingM })}
        >
          Queue depth-charge drop
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear drop order
          </button>
        )}
      </div>

      {!canDrop && depthChargeLoad > 0 && (
        <p className="muted mono" style={{ margin: 0 }}>
          Need {need} charges for this pattern (have {depthChargeLoad}).
        </p>
      )}

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: {pending.pattern} · set {Math.round(pending.depthSettingM)} m
        </p>
      )}

      {tracks.some((t) => t.status === 'sinking') && (
        <div className="weapons-track-list">
          <span className="mono muted">Sinking charges</span>
          <ul className="mono" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {tracks
              .filter((t) => t.status === 'sinking')
              .map((t) => (
                <li key={t.id}>
                  D{Math.round(t.position.depth)}→{Math.round(t.depthSettingM)} m
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
