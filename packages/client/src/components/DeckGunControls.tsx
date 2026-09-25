import { useState } from 'react';
import {
  DECK_GUN_MAX_RANGE_NM,
  DECK_GUN_RELOAD_TURNS,
  DECK_GUN_SHELL_SPEED_KN,
  RADAR_SURFACE_DEPTH_M,
  defaultDeckGunLoad,
  formatDeckGunFireBlockNotice,
  maxDeckGunShotsPerTurn,
  relativeBearingDeg,
  torpedoFireHeadingFromSolution,
  trueBearingFromRelative,
  type DeckGunFireBlock,
  type DeckGunFireOrder,
  type HullClass,
  type VesselType,
} from '@war-patrol/shared';
import { formatRelBearing } from './OpticsBearingCompass';
import { TouchNumber } from './TouchNumber';

interface Props {
  ownHeading: number;
  vesselType: VesselType;
  hullClass: HullClass;
  keelDepthM: number;
  deckGunLoad: number;
  awaitingReload?: boolean;
  reloadTurnsRemaining?: number;
  pending?: DeckGunFireOrder;
  fireBlock?: DeckGunFireBlock;
  disabled?: boolean;
  reloadBusy?: boolean;
  onSubmit: (order: DeckGunFireOrder) => void;
  onClear?: () => void;
  onReload?: () => void;
}

/** Fold to (−180, 180] for optics-style relative aim. */
function foldRelativeBearing(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/** Parse typed relative aim: "90", "+90", "90 stbd", "90 port". */
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
 * Deck-gun firing panel — destroyer + fleet-sub surface engagement.
 * Same calculator language as torpedoes (relative aim + course/speed/range
 * solution). Never auto-fills from sim truth. Sub fire requires surfaced/awash.
 * Shot count (1…class max) fires a multi-round salvo — 1 shell each.
 */
export function DeckGunControls({
  ownHeading,
  vesselType,
  hullClass,
  keelDepthM,
  deckGunLoad,
  awaitingReload = false,
  reloadTurnsRemaining = 0,
  pending,
  fireBlock,
  disabled,
  reloadBusy,
  onSubmit,
  onClear,
  onReload,
}: Props) {
  const capacity = defaultDeckGunLoad({ class: hullClass, type: vesselType });
  const maxShots = maxDeckGunShotsPerTurn({ class: hullClass, type: vesselType });
  const [aimRelative, setAimRelative] = useState(() =>
    pending ? Math.round(relativeBearingDeg(ownHeading, pending.aimHeading)) : 0,
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
  const [shotCount, setShotCount] = useState(() => {
    const pendingN = Math.floor(Number(pending?.shotCount) || 1);
    const cap = Math.max(1, Math.min(maxShots, Math.max(1, deckGunLoad || 1)));
    return Math.min(cap, Math.max(1, pendingN));
  });

  const aimTrue = trueBearingFromRelative(ownHeading, aimRelative);
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: aimTrue,
    estimatedCourse,
    estimatedSpeedKn,
    estimatedRangeNm,
    torpedoSpeedKn: DECK_GUN_SHELL_SPEED_KN,
  });
  const fireHeading = solution.fireHeading;
  const lead = ((fireHeading - aimTrue + 540) % 360) - 180;

  const submerged =
    vesselType === 'Submarine' && keelDepthM > RADAR_SURFACE_DEPTH_M;
  const magBlocked =
    awaitingReload || reloadTurnsRemaining > 0 || deckGunLoad <= 0;
  const shotCap = Math.max(1, Math.min(maxShots, Math.max(1, deckGunLoad)));
  const effectiveShots = Math.min(shotCap, Math.max(1, Math.floor(shotCount) || 1));
  const canQueue =
    !disabled &&
    !magBlocked &&
    !submerged &&
    estimatedRangeNm > 0 &&
    estimatedRangeNm <= DECK_GUN_MAX_RANGE_NM &&
    effectiveShots >= 1 &&
    effectiveShots <= deckGunLoad;

  let magStatus = `${deckGunLoad}/${capacity} shells ready`;
  if (reloadTurnsRemaining > 0) {
    magStatus = `reloading · ${reloadTurnsRemaining} turn${reloadTurnsRemaining === 1 ? '' : 's'} left · ${deckGunLoad}/${capacity} left`;
  } else if (awaitingReload) {
    magStatus = `awaiting reload · ${deckGunLoad}/${capacity} left`;
  } else if (deckGunLoad <= 0) {
    magStatus = 'empty — umpire rearm';
  }

  const inputsDisabled = disabled || magBlocked || submerged;

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        <h2>Guns</h2>
        <p className="muted station-instrument-blurb">
          Deck gun · {magStatus} · max {maxShots}/turn (slow fire) · reload{' '}
          {DECK_GUN_RELOAD_TURNS} turns · max {DECK_GUN_MAX_RANGE_NM} nm · surface only
        </p>
      </div>

      {fireBlock && (
        <p className="mono readout" style={{ margin: 0, color: 'var(--warn, #c90)' }}>
          {formatDeckGunFireBlockNotice(fireBlock)}
        </p>
      )}

      {submerged && (
        <p className="mono readout" style={{ margin: 0, color: 'var(--warn, #c90)' }}>
          Surfaced / awash required (keel ≤ {RADAR_SURFACE_DEPTH_M} m) — now{' '}
          {Math.round(keelDepthM)} m
        </p>
      )}

      {onReload && (
        <div className="control-actions">
          <button
            type="button"
            disabled={
              disabled || reloadBusy || !awaitingReload || reloadTurnsRemaining > 0
            }
            onClick={onReload}
          >
            Reload gun
            {reloadTurnsRemaining > 0 ? ` (${reloadTurnsRemaining})` : ''}
          </button>
        </div>
      )}

      <TouchNumber
        label="Aim / LOS (relative)"
        value={aimRelative}
        onChange={(v) => setAimRelative(foldRelativeBearing(v))}
        min={-180}
        max={179}
        step={1}
        wrap
        unit="°"
        disabled={inputsDisabled}
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
          : ' · no intercept (aim)'}
      </p>

      <TouchNumber
        label="Est. target course (true °)"
        value={estimatedCourse}
        onChange={(v) => setEstimatedCourse(((Math.round(v) % 360) + 360) % 360)}
        min={0}
        max={359}
        step={1}
        wrap
        unit="°"
        disabled={inputsDisabled}
      />
      <TouchNumber
        label="Est. target speed"
        value={estimatedSpeedKn}
        onChange={setEstimatedSpeedKn}
        min={0}
        max={50}
        step={0.1}
        unit="kn"
        disabled={inputsDisabled}
      />
      <TouchNumber
        label="Est. range"
        value={estimatedRangeNm}
        onChange={setEstimatedRangeNm}
        min={0}
        max={DECK_GUN_MAX_RANGE_NM}
        step={0.01}
        unit="nm"
        disabled={inputsDisabled}
      />
      <TouchNumber
        label="Rounds this turn"
        value={effectiveShots}
        onChange={(v) => setShotCount(Math.min(shotCap, Math.max(1, Math.floor(v) || 1)))}
        min={1}
        max={shotCap}
        step={1}
        unit=""
        disabled={inputsDisabled}
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        Slow-firing gun · max {maxShots} rd/turn · salvo {effectiveShots} · consumes{' '}
        {effectiveShots} shell{effectiveShots === 1 ? '' : 's'} ·{' '}
        {Math.max(0, deckGunLoad - effectiveShots)}/{capacity} left after fire
      </p>

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
              shotCount: effectiveShots,
            })
          }
        >
          Queue deck-gun fire
          {effectiveShots > 1 ? ` ×${effectiveShots}` : ''}
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear gun order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Of record: {Math.max(1, Math.floor(Number(pending.shotCount) || 1))} rd
          {Math.max(1, Math.floor(Number(pending.shotCount) || 1)) === 1 ? '' : 's'} · aim{' '}
          {String(Math.round(pending.aimHeading)).padStart(3, '0')}° · CRS{' '}
          {String(Math.round(pending.estimatedCourse)).padStart(3, '0')}° ·{' '}
          {pending.estimatedSpeedKn.toFixed(1)} kn · {pending.estimatedRangeNm.toFixed(2)} nm
        </p>
      )}
    </section>
  );
}
