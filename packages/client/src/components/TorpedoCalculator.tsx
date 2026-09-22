import { useState } from 'react';
import {
  FLEET_SUB_TORPEDO_AFT,
  FLEET_SUB_TORPEDO_FORWARD,
  RECOGNITION_MANUAL_ENTRIES,
  TORPEDO_AFT_ARC_HALF_DEG,
  TORPEDO_FORWARD_ARC_HALF_DEG,
  TORPEDO_MAX_RUN_NM,
  TORPEDO_RELOAD_TURNS,
  TORPEDO_SPEED_KN,
  TORPEDO_SPREAD_DEFAULT_DEG,
  TORPEDO_SPREAD_MAX_COUNT,
  TORPEDO_SPREAD_MAX_DEG,
  checkTorpedoOrderArc,
  formatTorpedoArcBlockNotice,
  formatTorpedoArcRejectMessage,
  relativeBearingDeg,
  torpedoFireHeadingFromSolution,
  torpedoRoomArcHalfDeg,
  trueBearingFromRelative,
  type TorpedoArcBlock,
  type TorpedoFireOrder,
  type TorpedoRoomId,
  type TorpedoTrack,
} from '@war-patrol/shared';
import { formatRelBearing } from './OpticsBearingCompass';
import { TouchNumber } from './TouchNumber';

interface RoomState {
  ready: number;
  awaitingReload: boolean;
  reloadTurnsRemaining: number;
}

interface Props {
  ownHeading: number;
  /** Helm set-point; the hull may reach it before the salvo launches. */
  orderedCourse?: number;
  forward: RoomState;
  aft: RoomState;
  pending?: TorpedoFireOrder;
  /** Last salvo dropped at resolve for being outside the room arc (no fish spent). */
  arcBlock?: TorpedoArcBlock;
  running?: TorpedoTrack[];
  disabled?: boolean;
  reloadBusy?: boolean;
  onSubmit: (order: TorpedoFireOrder) => void;
  onClear?: () => void;
  onReload?: (room: TorpedoRoomId) => void;
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

function roomCanFire(room: RoomState): boolean {
  return room.ready > 0 && !room.awaitingReload && room.reloadTurnsRemaining <= 0;
}

function roomStatus(room: RoomState, capacity: number): string {
  if (room.reloadTurnsRemaining > 0) {
    return `reloading · ${room.reloadTurnsRemaining} turn${room.reloadTurnsRemaining === 1 ? '' : 's'} left`;
  }
  if (room.awaitingReload) {
    return 'awaiting reload';
  }
  if (room.ready <= 0) {
    return 'empty — umpire rearm';
  }
  return `${room.ready}/${capacity} ready`;
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
  orderedCourse,
  forward,
  aft,
  pending,
  arcBlock,
  running = [],
  disabled,
  reloadBusy,
  onSubmit,
  onClear,
  onReload,
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
  const [room, setRoom] = useState<TorpedoRoomId>(() => pending?.room ?? 'forward');
  const [spreadCount, setSpreadCount] = useState(
    () => pending?.spreadCount ?? 1,
  );
  const [spreadDeg, setSpreadDeg] = useState(
    () => pending?.spreadDeg ?? TORPEDO_SPREAD_DEFAULT_DEG,
  );
  const [manualOpen, setManualOpen] = useState(false);

  const selected = room === 'aft' ? aft : forward;
  const capacity = room === 'aft' ? FLEET_SUB_TORPEDO_AFT : FLEET_SUB_TORPEDO_FORWARD;
  const aimTrue = trueBearingFromRelative(ownHeading, aimRelative);
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: aimTrue,
    estimatedCourse,
    estimatedSpeedKn,
    estimatedRangeNm,
  });
  const fireHeading = solution.fireHeading;
  const lead = ((fireHeading - aimTrue + 540) % 360) - 180;
  const maxCount = Math.max(1, Math.min(TORPEDO_SPREAD_MAX_COUNT, selected.ready || 1));
  const effectiveCount = Math.min(spreadCount, maxCount);
  const loadBlocked = !roomCanFire(selected);
  const arcHalf = torpedoRoomArcHalfDeg(room);
  const arcCheck = checkTorpedoOrderArc({
    ownHeadingDeg: ownHeading,
    room,
    aimHeading: aimTrue,
    estimatedCourse,
    estimatedSpeedKn,
    estimatedRangeNm,
    spreadCount: effectiveCount,
    spreadDeg,
  });
  const gyro = arcCheck.gyroDeg;
  const arcBlocked = !arcCheck.ok;
  // Arc is validated again at resolve against the heading the hull actually
  // reaches, so a helm order can still swing a queued salvo out of the cone.
  const courseArcWarning =
    !arcBlocked &&
    orderedCourse != null &&
    Math.round(orderedCourse) !== Math.round(ownHeading) &&
    !checkTorpedoOrderArc({
      ownHeadingDeg: orderedCourse,
      room,
      aimHeading: aimTrue,
      estimatedCourse,
      estimatedSpeedKn,
      estimatedRangeNm,
      spreadCount: effectiveCount,
      spreadDeg,
    }).ok;
  const pendingArcCheck = pending
    ? checkTorpedoOrderArc({
        ownHeadingDeg: ownHeading,
        room: pending.room,
        aimHeading: pending.aimHeading,
        estimatedCourse: pending.estimatedCourse,
        estimatedSpeedKn: pending.estimatedSpeedKn,
        estimatedRangeNm: pending.estimatedRangeNm,
        spreadCount: pending.spreadCount,
        spreadDeg: pending.spreadDeg,
      })
    : null;
  const canQueue =
    !disabled &&
    !loadBlocked &&
    !arcBlocked &&
    estimatedRangeNm > 0 &&
    estimatedLengthM > 0;

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        <h2>Torpedo calculator</h2>
        <p className="muted station-instrument-blurb">
          {TORPEDO_SPEED_KN} kn · {TORPEDO_MAX_RUN_NM} nm · bow ±
          {TORPEDO_FORWARD_ARC_HALF_DEG}° / stern ±{TORPEDO_AFT_ARC_HALF_DEG}° · reload{' '}
          {TORPEDO_RELOAD_TURNS} turns
        </p>
      </div>

      <fieldset className="weapons-plot-fieldset" disabled={disabled}>
        <legend className="mono">Room</legend>
        <div className="weapons-plot-row">
          <button
            type="button"
            className={room === 'forward' ? 'primary' : undefined}
            aria-pressed={room === 'forward'}
            onClick={() => setRoom('forward')}
          >
            Forward ({forward.ready}/{FLEET_SUB_TORPEDO_FORWARD})
          </button>
          <button
            type="button"
            className={room === 'aft' ? 'primary' : undefined}
            aria-pressed={room === 'aft'}
            onClick={() => setRoom('aft')}
          >
            Aft ({aft.ready}/{FLEET_SUB_TORPEDO_AFT})
          </button>
        </div>
        <p className="mono muted" style={{ margin: '0.35rem 0 0', fontSize: '0.8rem' }}>
          FWD {roomStatus(forward, FLEET_SUB_TORPEDO_FORWARD)} · AFT{' '}
          {roomStatus(aft, FLEET_SUB_TORPEDO_AFT)}
        </p>
        <p className="mono muted" style={{ margin: '0.25rem 0 0', fontSize: '0.8rem' }}>
          {room === 'aft' ? 'Aft' : 'Forward'} arc ±{arcHalf}°{' '}
          {room === 'aft' ? 'astern' : 'ahead'}
        </p>
      </fieldset>

      <div className="control-actions">
        {onReload && (
          <>
            <button
              type="button"
              disabled={
                disabled ||
                reloadBusy ||
                !forward.awaitingReload ||
                forward.reloadTurnsRemaining > 0
              }
              onClick={() => onReload('forward')}
            >
              Reload forward
              {forward.reloadTurnsRemaining > 0
                ? ` (${forward.reloadTurnsRemaining})`
                : ''}
            </button>
            <button
              type="button"
              disabled={
                disabled || reloadBusy || !aft.awaitingReload || aft.reloadTurnsRemaining > 0
              }
              onClick={() => onReload('aft')}
            >
              Reload aft
              {aft.reloadTurnsRemaining > 0 ? ` (${aft.reloadTurnsRemaining})` : ''}
            </button>
          </>
        )}
      </div>

      <TouchNumber
        label="Aim / LOS (relative)"
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
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        True LOS {String(Math.round(aimTrue)).padStart(3, '0')}° (own HDG{' '}
        {String(Math.round(ownHeading)).padStart(3, '0')}° + {formatRelBearing(aimRelative)})
        {' · '}
        Fire HDG {String(Math.round(fireHeading)).padStart(3, '0')}°
        {solution.solvable
          ? ` · lead ${lead >= 0 ? '+' : ''}${Math.round(lead)}°`
          : ' · no intercept (aim)'}{' '}
        · tube gyro {gyro >= 0 ? '+' : ''}
        {Math.round(gyro)}° (vs {room === 'aft' ? 'stern' : 'bow'})
        {effectiveCount > 1
          ? ` · fan ×${effectiveCount} @${spreadDeg}° (center fire)`
          : ''}
        {' · '}
        {arcBlocked ? (
          <span style={{ color: 'var(--warn, #c45c26)' }}>
            OUT OF ARC ({formatTorpedoArcRejectMessage(arcCheck)})
          </span>
        ) : (
          <span>in arc ±{arcHalf}°</span>
        )}
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
      />

      <div className="recognition-manual">
        <button
          type="button"
          className="recognition-manual-toggle"
          disabled={disabled || loadBlocked}
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((o) => !o)}
        >
          Recognition manual {manualOpen ? '▴' : '▾'}
        </button>
        {manualOpen && (
          <div className="recognition-manual-body">
            <ul className="recognition-manual-list">
              {RECOGNITION_MANUAL_ENTRIES.map((entry) => {
                const selectedLen = estimatedLengthM === entry.lengthM;
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      className={
                        selectedLen
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
              room,
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
          {effectiveCount > 1 ? ` (×${effectiveCount})` : ''} · {room === 'aft' ? 'aft' : 'fwd'}
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear fire order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: {pending.room === 'aft' ? 'aft' : 'fwd'} · aim{' '}
          {formatRelBearing(relativeBearingDeg(ownHeading, pending.aimHeading))} (true{' '}
          {String(Math.round(pending.aimHeading)).padStart(3, '0')}°)
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

      {loadBlocked && (
        <p className="mono muted" style={{ margin: 0 }}>
          Selected room: {roomStatus(selected, capacity)}
        </p>
      )}

      {arcBlocked && !loadBlocked && (
        <p className="mono muted" style={{ margin: 0 }}>
          Cannot queue — {formatTorpedoArcRejectMessage(arcCheck)}
        </p>
      )}

      {courseArcWarning && !loadBlocked && (
        <p className="mono muted" style={{ margin: 0 }}>
          Ordered course {String(Math.round(orderedCourse!)).padStart(3, '0')}° swings this shot
          outside the ±{arcHalf}° {room === 'aft' ? 'stern' : 'bow'} arc
        </p>
      )}

      {pendingArcCheck && !pendingArcCheck.ok && (
        <p className="mono" style={{ margin: 0, color: 'var(--warn, #c45c26)' }}>
          Order of record OUT OF ARC ({formatTorpedoArcRejectMessage(pendingArcCheck)}) — will not
          launch
        </p>
      )}

      {arcBlock && (
        <p className="mono" style={{ margin: 0, color: 'var(--warn, #c45c26)' }}>
          {formatTorpedoArcBlockNotice(arcBlock)}
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
