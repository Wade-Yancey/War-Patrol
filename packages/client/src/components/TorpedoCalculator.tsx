import { useState } from 'react';
import {
  RECOGNITION_MANUAL_ENTRIES,
  TORPEDO_MAX_RUN_NM,
  TORPEDO_SPEED_KN,
  TORPEDO_SPREAD_DEFAULT_DEG,
  TORPEDO_SPREAD_MAX_COUNT,
  TORPEDO_SPREAD_MAX_DEG,
  relativeBearingDeg,
  torpedoFireHeadingFromSolution,
  trueBearingFromRelative,
  type TorpedoFireOrder,
  type TorpedoTrack,
} from '@war-patrol/shared';
import { formatRelBearing } from './OpticsBearingCompass';
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

/** Fold to (−180, 180] for optics-style relative aim. */
function foldRelativeBearing(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Parse typed relative aim: "90", "+90", "90 stbd", "90 port", "000° rel". */
function parseRelAim(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const port = /\bport\b/.test(s);
  const stbd = /\b(stbd|starboard)\b/.test(s);
  const m = s.match(/-?\d+/);
  if (!m) return null;
  let n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  if (port) n = -Math.abs(n);
  else if (stbd) n = Math.abs(n);
  return Math.round(foldRelativeBearing(n));
}

/**
 * Torpedo firing calculator — all solution inputs are operator-entered.
 * Never auto-fills true course/speed/range/length from the sim (optics +
 * recognition manual + judgment). Aim = relative LOS; course/speed/range
 * compute the fire heading; length scales the geometric hit gate vs truth.
 * Run depth is fixed in sim (shallow anti-surface default) — not operator-set.
 * Supports single shot or angular fan spreads (multiple tracked fish).
 * Fire is allowed with the periscope down.
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
  // Relative aim matches optics (bow 0, stbd +, port −). Server still gets true aimHeading.
  const [aimRelative, setAimRelative] = useState(() =>
    pending
      ? Math.round(relativeBearingDeg(ownHeading, pending.aimHeading))
      : 0,
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
  const [estimatedLengthM, setEstimatedLengthM] = useState(
    () => pending?.estimatedLengthM ?? 0,
  );
  const [spreadCount, setSpreadCount] = useState(
    () => pending?.spreadCount ?? 1,
  );
  const [spreadDeg, setSpreadDeg] = useState(
    () => pending?.spreadDeg ?? TORPEDO_SPREAD_DEFAULT_DEG,
  );
  const [manualOpen, setManualOpen] = useState(false);

  const aimTrue = trueBearingFromRelative(ownHeading, aimRelative);
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
  const canQueue =
    !disabled && !loadBlocked && estimatedRangeNm > 0 && estimatedLengthM > 0;

  return (
    <section className="panel stack controls-weapons-panel">
      <div className="controls-section-head">
        <h2>Torpedo calculator</h2>
        <p className="muted controls-section-blurb">
          Aim uses the same relative bearing as optics (bow 0 · stbd + · port −) — not true
          compass. Enter target true course (not AOB), speed, range, and OA length from the
          recognition manual — wrong length shrinks the hit window. Fish run the computed
          intercept. Load {torpedoLoad} fish · Mk14-ish {TORPEDO_SPEED_KN} kn /{' '}
          {TORPEDO_MAX_RUN_NM} nm. Fire allowed with scope down.
        </p>
      </div>

      <TouchNumber
        label="Aim / LOS (relative — same as optics)"
        value={aimRelative}
        onChange={(v) => setAimRelative(foldRelativeBearing(v))}
        min={-180}
        max={179}
        step={1}
        wrap
        unit="°"
        disabled={disabled || loadBlocked}
        format={(v) => formatRelBearing(v)}
        parse={parseRelAim}
        hint="Match optics: 000° rel / 090° stbd / 090° port — not true compass"
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        True LOS {String(Math.round(aimTrue)).padStart(3, '0')}° (own HDG{' '}
        {String(Math.round(ownHeading)).padStart(3, '0')}° + {formatRelBearing(aimRelative)})
        {' · '}
        Fire HDG {String(Math.round(fireHeading)).padStart(3, '0')}°
        {solution.solvable
          ? ` · lead ${lead >= 0 ? '+' : ''}${Math.round(lead)}°`
          : ' · no intercept (aim)'}{' '}
        · gyro {gyro >= 0 ? '+' : ''}
        {Math.round(gyro)}°
        {effectiveCount > 1
          ? ` · fan ×${effectiveCount} @${spreadDeg}° (center fire)`
          : ''}
      </p>

      <TouchNumber
        label="Est. target course (true ° — not AOB)"
        value={estimatedCourse}
        onChange={setEstimatedCourse}
        min={0}
        max={359}
        step={1}
        wrap
        unit="°"
        disabled={disabled || loadBlocked}
        format={(v) => `${String(v).padStart(3, '0')}°`}
        hint="Target's true heading on the compass — not angle-on-bow"
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
        label="Est. target length (OA)"
        value={estimatedLengthM}
        onChange={setEstimatedLengthM}
        min={0}
        max={400}
        step={5}
        unit="m"
        disabled={disabled || loadBlocked}
        hint="From recognition manual — wrong class length shrinks the hit gate"
      />

      <div className="recognition-manual">
        <button
          type="button"
          className="recognition-manual-toggle"
          disabled={disabled || loadBlocked}
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((o) => !o)}
        >
          Recognition manual — class OA lengths {manualOpen ? '▴' : '▾'}
        </button>
        {manualOpen && (
          <div className="recognition-manual-body">
            <p className="muted recognition-manual-blurb">
              Identify the silhouette class, then tap a plate to set length. Longer hulls are
              easier to hit when ID is correct; guessing hurts either way.
            </p>
            <ul className="recognition-manual-list">
              {RECOGNITION_MANUAL_ENTRIES.map((entry) => {
                const selected = estimatedLengthM === entry.lengthM;
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={
                        selected
                          ? 'recognition-manual-row is-selected'
                          : 'recognition-manual-row'
                      }
                      disabled={disabled || loadBlocked}
                      onClick={() => setEstimatedLengthM(entry.lengthM)}
                    >
                      <span className="recognition-manual-name">{entry.name}</span>
                      <span className="mono recognition-manual-dims">
                        L {entry.lengthM} m · B {entry.beamM} m
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

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
          disabled={!canQueue}
          onClick={() =>
            onSubmit({
              aimHeading: aimTrue,
              estimatedCourse,
              estimatedSpeedKn,
              estimatedRangeNm,
              estimatedLengthM,
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
          Of record: aim {formatRelBearing(relativeBearingDeg(ownHeading, pending.aimHeading))}{' '}
          (true {String(Math.round(pending.aimHeading)).padStart(3, '0')}°)
          {pending.spreadCount && pending.spreadCount > 1
            ? ` · ×${pending.spreadCount}@${pending.spreadDeg ?? 0}°`
            : ''}{' '}
          · tgt CRS {String(Math.round(pending.estimatedCourse)).padStart(3, '0')}° ·{' '}
          {Math.round(pending.estimatedSpeedKn)}kn · {pending.estimatedRangeNm.toFixed(1)}nm · L
          {Math.round(pending.estimatedLengthM)}m
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
                  {t.remainingRunNm.toFixed(1)} nm · L{Math.round(t.estimatedLengthM)}m
                </li>
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}
