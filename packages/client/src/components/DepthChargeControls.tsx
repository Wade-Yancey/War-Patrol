import { useState } from 'react';
import {
  DEPTH_CHARGE_DEFAULT_DEPTH_M,
  DEPTH_CHARGE_MAX_DEPTH_M,
  DEPTH_CHARGE_MIN_DEPTH_M,
  DEPTH_CHARGE_RELOAD_TURNS,
  DESTROYER_DEPTH_CHARGE_LOAD,
  depthChargePatternCount,
  type DepthChargeDropOrder,
  type DepthChargePattern,
  type DepthChargeTrack,
} from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

interface Props {
  depthChargeLoad: number;
  awaitingReload?: boolean;
  reloadTurnsRemaining?: number;
  pending?: DepthChargeDropOrder;
  tracks?: DepthChargeTrack[];
  disabled?: boolean;
  reloadBusy?: boolean;
  onSubmit: (order: DepthChargeDropOrder) => void;
  onClear?: () => void;
  onReload?: () => void;
}

const PATTERNS: Array<{ id: DepthChargePattern; label: string }> = [
  { id: 'single', label: 'Single' },
  { id: 'pair', label: 'Pair' },
  { id: 'pattern_3', label: 'Pattern 6' },
  { id: 'pattern_5', label: 'Pattern 10' },
];

/** Destroyer depth-charge drop panel — pattern + depth setting + rack reload. */
export function DepthChargeControls({
  depthChargeLoad,
  awaitingReload = false,
  reloadTurnsRemaining = 0,
  pending,
  tracks = [],
  disabled,
  reloadBusy,
  onSubmit,
  onClear,
  onReload,
}: Props) {
  const [pattern, setPattern] = useState<DepthChargePattern>(
    () => pending?.pattern ?? 'pattern_3',
  );
  const [depthSettingM, setDepthSettingM] = useState(
    () => pending?.depthSettingM ?? DEPTH_CHARGE_DEFAULT_DEPTH_M,
  );

  const need = depthChargePatternCount(pattern);
  const rackBlocked = awaitingReload || reloadTurnsRemaining > 0 || depthChargeLoad <= 0;
  const canDrop = !rackBlocked && depthChargeLoad >= need;

  let rackStatus = `${depthChargeLoad}/${DESTROYER_DEPTH_CHARGE_LOAD} ready`;
  if (reloadTurnsRemaining > 0) {
    rackStatus = `reloading · ${reloadTurnsRemaining} turn${reloadTurnsRemaining === 1 ? '' : 's'} left`;
  } else if (awaitingReload) {
    rackStatus = 'awaiting reload';
  } else if (depthChargeLoad <= 0) {
    rackStatus = 'empty — umpire rearm';
  }

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        <h2>Depth charges</h2>
        <p className="muted station-instrument-blurb">
          Finite rack ({DESTROYER_DEPTH_CHARGE_LOAD} max). Pattern consumes charges on resolve.
          After a drop press Reload ({DEPTH_CHARGE_RELOAD_TURNS} turns before the next drop).
          Set depth from sonar estimate — match vs target keel drives effect. {rackStatus}.
        </p>
      </div>

      {onReload && (
        <div className="control-actions">
          <button
            type="button"
            disabled={
              disabled || reloadBusy || !awaitingReload || reloadTurnsRemaining > 0
            }
            onClick={onReload}
          >
            Reload rack
            {reloadTurnsRemaining > 0 ? ` (${reloadTurnsRemaining})` : ''}
          </button>
        </div>
      )}

      <fieldset className="weapons-plot-fieldset" disabled={disabled || rackBlocked}>
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
        disabled={disabled || rackBlocked}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={disabled || !canDrop}
          onClick={() => onSubmit({ pattern, depthSettingM })}
        >
          Queue depth-charge drop ({need})
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear drop order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: {pending.pattern} · set {pending.depthSettingM} m
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
                  set {t.depthSettingM} m · now {Math.round(t.position.depth)} m
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
