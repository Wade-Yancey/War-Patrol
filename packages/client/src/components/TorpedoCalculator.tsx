import { useState } from 'react';
import {
  TORPEDO_MAX_RUN_NM,
  TORPEDO_SPEED_KN,
  TORPEDO_SPREAD_DEFAULT_DEG,
  TORPEDO_SPREAD_MAX_COUNT,
  TORPEDO_SPREAD_MAX_DEG,
  type TorpedoFireOrder,
  type TorpedoTrack,
} from '@war-patrol/shared';
import { TouchNumber } from './TouchNumber';

interface Props {
  ownHeading: number;
  torpedoLoad: number;
  pending?: TorpedoFireOrder;
  running?: TorpedoTrack[];
  disabled?: boolean;
  onSubmit: (order: TorpedoFireOrder) => void;
  onClear?: () => void;
}

/**
 * Torpedo firing calculator — all solution inputs are operator-entered.
 * Never auto-fills true length/speed from the sim (recognition manual + optics).
 * Run depth is fixed in sim (shallow anti-surface default) — not operator-set.
 * Supports single shot or angular fan spreads (multiple tracked fish).
 */
export function TorpedoCalculator({
  ownHeading,
  torpedoLoad,
  pending,
  running = [],
  disabled,
  onSubmit,
  onClear,
}: Props) {
  const [aimHeading, setAimHeading] = useState(
    () => Math.round(pending?.aimHeading ?? ownHeading),
  );
  const [estimatedLengthM, setEstimatedLengthM] = useState(
    () => pending?.estimatedLengthM ?? 0,
  );
  const [estimatedSpeedKn, setEstimatedSpeedKn] = useState(
    () => pending?.estimatedSpeedKn ?? 0,
  );
  const [spreadCount, setSpreadCount] = useState(
    () => pending?.spreadCount ?? 1,
  );
  const [spreadDeg, setSpreadDeg] = useState(
    () => pending?.spreadDeg ?? TORPEDO_SPREAD_DEFAULT_DEG,
  );

  const gyro = ((aimHeading - ownHeading + 540) % 360) - 180;
  const maxCount = Math.max(1, Math.min(TORPEDO_SPREAD_MAX_COUNT, torpedoLoad || 1));
  const effectiveCount = Math.min(spreadCount, maxCount);
  const loadBlocked = torpedoLoad <= 0;

  return (
    <section className="panel stack controls-weapons-panel">
      <div className="controls-section-head">
        <h2>Torpedo calculator</h2>
        <p className="muted controls-section-blurb">
          Enter estimates from recognition manual + optics — nothing is auto-filled from truth.
          Load {torpedoLoad} fish · Mk14-ish {TORPEDO_SPEED_KN} kn / {TORPEDO_MAX_RUN_NM} nm.
        </p>
      </div>

      <TouchNumber
        label="Aim heading (true)"
        value={aimHeading}
        onChange={setAimHeading}
        min={0}
        max={359}
        step={1}
        wrap
        unit="°"
        disabled={disabled || loadBlocked}
        format={(v) => `${String(v).padStart(3, '0')}°`}
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        Gyro vs own HDG {String(Math.round(ownHeading)).padStart(3, '0')}° →{' '}
        {gyro >= 0 ? '+' : ''}
        {Math.round(gyro)}°
        {effectiveCount > 1
          ? ` · fan ×${effectiveCount} @${spreadDeg}° (center aim)`
          : ''}
      </p>

      <TouchNumber
        label="Est. target length (manual)"
        value={estimatedLengthM}
        onChange={setEstimatedLengthM}
        min={0}
        max={400}
        step={5}
        unit="m"
        disabled={disabled || loadBlocked}
      />
      <TouchNumber
        label="Est. target speed"
        value={estimatedSpeedKn}
        onChange={setEstimatedSpeedKn}
        min={0}
        max={50}
        step={1}
        unit="kn"
        disabled={disabled || loadBlocked}
      />

      <TouchNumber
        label="Spread count"
        value={spreadCount}
        onChange={(v) => setSpreadCount(Math.min(maxCount, Math.max(1, v)))}
        min={1}
        max={maxCount}
        step={1}
        unit="fish"
        disabled={disabled || loadBlocked}
      />
      <TouchNumber
        label="Spread interval"
        value={spreadDeg}
        onChange={setSpreadDeg}
        min={0}
        max={TORPEDO_SPREAD_MAX_DEG}
        step={0.5}
        unit="°"
        disabled={disabled || loadBlocked || effectiveCount <= 1}
      />

      <div className="control-actions">
        <button
          className="primary"
          type="button"
          disabled={disabled || loadBlocked || estimatedLengthM <= 0}
          onClick={() =>
            onSubmit({
              aimHeading,
              estimatedLengthM,
              estimatedSpeedKn,
              spreadCount: effectiveCount,
              spreadDeg,
            })
          }
        >
          Queue torpedo fire
          {effectiveCount > 1 ? ` (×${effectiveCount})` : ''}
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear fire order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: aim {String(Math.round(pending.aimHeading)).padStart(3, '0')}°
          {pending.spreadCount && pending.spreadCount > 1
            ? ` · ×${pending.spreadCount}@${pending.spreadDeg ?? 0}°`
            : ''}{' '}
          · L{Math.round(pending.estimatedLengthM)}m · {Math.round(pending.estimatedSpeedKn)}kn
        </p>
      )}

      {running.length > 0 && (
        <div className="weapons-track-list">
          <span className="mono muted">Running fish</span>
          <ul className="mono" style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {running
              .filter((t) => t.status === 'running')
              .map((t) => (
                <li key={t.id}>
                  HDG {String(Math.round(t.heading)).padStart(3, '0')}° · rem{' '}
                  {t.remainingRunNm.toFixed(1)} nm
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
};
