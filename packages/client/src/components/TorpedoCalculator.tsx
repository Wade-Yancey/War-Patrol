import { useState } from 'react';
import {
  TORPEDO_MAX_RUN_NM,
  TORPEDO_SPEED_KN,
  TORPEDO_SPREAD_DEFAULT_DEG,
  TORPEDO_SPREAD_MAX_COUNT,
  TORPEDO_SPREAD_MAX_DEG,
  formatRelativeBearingLabel,
  relativeBearingDeg,
  torpedoFireHeadingFromSolution,
  trueBearingFromRelative,
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

function normalizeRelAim(rel: number): number {
  // Match relativeBearingDeg range (−180, 180].
  return relativeBearingDeg(0, rel);
}

function formatAimRel(rel: number): string {
  return formatRelativeBearingLabel(normalizeRelAim(rel));
}

function parseAimRel(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  const m = s.match(/(-?\d+)/);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (/\bport\b/.test(s) && n > 0) n = -n;
  if (/\b(stbd|starboard)\b/.test(s)) n = Math.abs(n);
  return normalizeRelAim(n);
}

/**
 * Torpedo firing calculator — all solution inputs are operator-entered.
 * Never auto-fills true course/speed/range from the sim (optics + judgment).
 *
 * Aim is entered as **relative bearing** (same language as optics: bow / port /
 * stbd). That avoids the common mix-up of pasting `000° rel` into a true-bearing
 * field (which aims reciprocal when own HDG is ~180°). Relative aim converts to
 * true LOS with own heading at queue time; course/speed/range compute the
 * intercept fire heading fish actually run.
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
  const [aimRel, setAimRel] = useState(() =>
    normalizeRelAim(
      pending
        ? relativeBearingDeg(ownHeading, pending.aimHeading)
        : 0,
    ),
  );
  const [estimatedCourse, setEstimatedCourse] = useState(
    () => Math.round(pending?.estimatedCourse ?? 0),
  );
  const [estimatedSpeedKn, setEstimatedSpeedKn] = useState(
    () => pending?.estimatedSpeedKn ?? 0,
  );
  const [estimatedRangeNm, setEstimatedRangeNm] = useState(
    () => pending?.estimatedRangeNm ?? 0,
  );
  const [spreadCount, setSpreadCount] = useState(
    () => pending?.spreadCount ?? 1,
  );
  const [spreadDeg, setSpreadDeg] = useState(
    () => pending?.spreadDeg ?? TORPEDO_SPREAD_DEFAULT_DEG,
  );

  const aimTrue = trueBearingFromRelative(ownHeading, aimRel);
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: aimTrue,
    estimatedCourse,
    estimatedSpeedKn,
    estimatedRangeNm,
  });
  const fireHeading = solution.fireHeading;
  const gyro = ((fireHeading - ownHeading + 540) % 360) - 180;
  const lead = ((fireHeading - aimTrue + 540) % 360) - 180;
  const maxCount = Math.max(1, Math.min(TORPEDO_SPREAD_MAX_COUNT, torpedoLoad || 1));
  const effectiveCount = Math.min(spreadCount, maxCount);
  const loadBlocked = torpedoLoad <= 0;
  const ownHdgLabel = String(Math.round(ownHeading)).padStart(3, '0');
  const aimTrueLabel = String(Math.round(aimTrue)).padStart(3, '0');
  const fireLabel = String(Math.round(fireHeading)).padStart(3, '0');

  return (
    <section className="panel stack controls-weapons-panel">
      <div className="controls-section-head">
        <h2>Torpedo calculator</h2>
        <p className="muted controls-section-blurb">
          Aim in relative bearing — same as optics (bow / port / stbd), not true
          compass. We convert to true LOS with your HDG. Enter target course /
          speed / range estimates; fish run the computed intercept. Hits are
          geometric (hull breadth). Load {torpedoLoad} fish · Mk14-ish{' '}
          {TORPEDO_SPEED_KN} kn / {TORPEDO_MAX_RUN_NM} nm. Fire allowed with scope
          down.
        </p>
      </div>

      <TouchNumber
        label="Aim / LOS (relative to bow)"
        value={aimRel}
        onChange={(v) => setAimRel(normalizeRelAim(v))}
        min={-180}
        max={179}
        step={1}
        wrap
        unit="°"
        disabled={disabled || loadBlocked}
        format={formatAimRel}
        parse={parseAimRel}
        hint="Same as optics: 0 bow, +stbd, −port · tap to type e.g. 45 stbd"
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        {formatAimRel(aimRel)} + own HDG {ownHdgLabel}° → true LOS {aimTrueLabel}°
      </p>
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        Fire HDG {fireLabel}°
        {solution.solvable
          ? ` · lead ${lead >= 0 ? '+' : ''}${Math.round(lead)}° vs LOS`
          : ' · no intercept (aim)'}{' '}
        · gyro vs own HDG {ownHdgLabel}° →{' '}
        {gyro >= 0 ? '+' : ''}
        {Math.round(gyro)}°
        {effectiveCount > 1
          ? ` · fan ×${effectiveCount} @${spreadDeg}° (center fire)`
          : ''}
      </p>

      <TouchNumber
        label="Est. target course (true)"
        value={estimatedCourse}
        onChange={setEstimatedCourse}
        min={0}
        max={359}
        step={1}
        wrap
        unit="°"
        disabled={disabled || loadBlocked}
        format={(v) => `${String(v).padStart(3, '0')}°`}
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
        label="Est. range"
        value={estimatedRangeNm}
        onChange={setEstimatedRangeNm}
        min={0}
        max={8}
        step={0.1}
        unit="nm"
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
          disabled={disabled || loadBlocked || estimatedRangeNm <= 0}
          onClick={() =>
            onSubmit({
              aimHeading: aimTrue,
              estimatedCourse,
              estimatedSpeedKn,
              estimatedRangeNm,
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
          Of record: LOS{' '}
          {formatAimRel(relativeBearingDeg(ownHeading, pending.aimHeading))} →
          true {String(Math.round(pending.aimHeading)).padStart(3, '0')}°
          {pending.spreadCount && pending.spreadCount > 1
            ? ` · ×${pending.spreadCount}@${pending.spreadDeg ?? 0}°`
            : ''}{' '}
          · tgt {String(Math.round(pending.estimatedCourse)).padStart(3, '0')}° ·{' '}
          {Math.round(pending.estimatedSpeedKn)}kn · {pending.estimatedRangeNm.toFixed(1)}nm
          {' → fire '}
          {String(
            Math.round(
              torpedoFireHeadingFromSolution({
                aimHeading: pending.aimHeading,
                estimatedCourse: pending.estimatedCourse,
                estimatedSpeedKn: pending.estimatedSpeedKn,
                estimatedRangeNm: pending.estimatedRangeNm,
              }).fireHeading,
            ),
          ).padStart(3, '0')}
          °
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
}
