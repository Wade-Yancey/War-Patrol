import { useEffect, useState } from 'react';
import {
  DEPTH_CHARGE_DEFAULT_DEPTH_M,
  DEPTH_CHARGE_MAX_DEPTH_M,
  DEPTH_CHARGE_MIN_DEPTH_M,
  DEPTH_CHARGE_RELOAD_TURNS,
  DESTROYER_DEPTH_CHARGE_LOAD,
  depthChargeCountFromOrder,
  type DepthChargeDropOrder,
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

/** Destroyer depth-charge drop panel — count slider + depth setting + optional rack reload. */
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
  const maxDrop = Math.max(0, Math.floor(depthChargeLoad));
  const pendingCount = pending
    ? depthChargeCountFromOrder(pending, Math.max(maxDrop, DESTROYER_DEPTH_CHARGE_LOAD))
    : 6;
  const [count, setCount] = useState(() =>
    Math.min(Math.max(1, pendingCount), Math.max(1, maxDrop || 1)),
  );
  const [depthSettingM, setDepthSettingM] = useState(
    () => pending?.depthSettingM ?? DEPTH_CHARGE_DEFAULT_DEPTH_M,
  );

  useEffect(() => {
    if (maxDrop <= 0) return;
    setCount((c) => Math.min(Math.max(1, c), maxDrop));
  }, [maxDrop]);

  const need = maxDrop > 0 ? Math.min(Math.max(1, count), maxDrop) : 0;
  const empty = maxDrop <= 0;
  const canDrop = !disabled && !empty && need > 0;

  let rackStatus = `${depthChargeLoad}/${DESTROYER_DEPTH_CHARGE_LOAD} ready`;
  if (reloadTurnsRemaining > 0) {
    rackStatus =
      maxDrop > 0
        ? `${depthChargeLoad}/${DESTROYER_DEPTH_CHARGE_LOAD} ready · reloading · ${reloadTurnsRemaining} turn${reloadTurnsRemaining === 1 ? '' : 's'} left`
        : `reloading · ${reloadTurnsRemaining} turn${reloadTurnsRemaining === 1 ? '' : 's'} left`;
  } else if (awaitingReload) {
    rackStatus =
      maxDrop > 0
        ? `${depthChargeLoad}/${DESTROYER_DEPTH_CHARGE_LOAD} ready · reload available`
        : 'empty — awaiting reload';
  } else if (empty) {
    rackStatus = 'empty — umpire rearm';
  }

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        <h2>Depth charges</h2>
        <p className="muted station-instrument-blurb">
          Rack {rackStatus} · reload {DEPTH_CHARGE_RELOAD_TURNS} turns (~
          {DEPTH_CHARGE_RELOAD_TURNS * 3} min) then rack refills
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

      <TouchNumber
        label="Charges to drop"
        value={need || 1}
        onChange={setCount}
        min={1}
        max={Math.max(1, maxDrop || 1)}
        step={1}
        unit=""
        disabled={disabled || empty}
        hint={empty ? 'Rack empty' : `1–${maxDrop} (full rack OK)`}
      />

      <TouchNumber
        label="Depth setting"
        value={depthSettingM}
        onChange={setDepthSettingM}
        min={DEPTH_CHARGE_MIN_DEPTH_M}
        max={DEPTH_CHARGE_MAX_DEPTH_M}
        step={5}
        unit="m"
        disabled={disabled || empty}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={!canDrop}
          onClick={() => onSubmit({ count: need, depthSettingM })}
        >
          Queue depth-charge drop ({need || 0})
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear drop order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: ×{depthChargeCountFromOrder(pending, DESTROYER_DEPTH_CHARGE_LOAD)} · set{' '}
          {pending.depthSettingM} m
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
