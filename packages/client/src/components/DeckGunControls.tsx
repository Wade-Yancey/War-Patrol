import { useState } from 'react';
import {
  DECK_GUN_MAX_RANGE_NM,
  DECK_GUN_MAX_VOLLEYS_PER_TURN,
  DECK_GUN_RELOAD_TURNS,
  DECK_GUN_SHELLS_PER_VOLLEY,
  DECK_GUN_SHELL_SPEED_KN,
  RADAR_SURFACE_DEPTH_M,
  defaultDeckGunLoad,
  deckGunShellsForVolleys,
  deckGunVolleysFromAmmo,
  formatContactDesignation,
  formatDeckGunFireBlockNotice,
  maxDeckGunVolleysPerTurn,
  relativeBearingDeg,
  torpedoFireHeadingFromSolution,
  trueBearingFromRelative,
  type DeckGunFireBlock,
  type DeckGunFireOrder,
  type HullClass,
  type VesselType,
} from '@war-patrol/shared';
import { formatRelBearing } from './OpticsBearingCompass';
import { StationInstrumentTitle } from './StationInfoButton';
import { stationGuideIdFor } from '../stationGuides';
import { TouchNumber } from './TouchNumber';

/** Optics / lookout contact that can prefill designate aim + range. */
export type DeckGunOpticsContact = {
  labelN: number;
  relativeBearing: number;
  rangeNm: number;
};

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
  /** Order write in flight — pressed chrome; still allows latest-wins resubmit. */
  writePending?: boolean;
  /** Optional Contact N list from lookout / periscope to fill aim + rough range. */
  opticsContacts?: DeckGunOpticsContact[];
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

function pendingVolleyCount(pending: DeckGunFireOrder | undefined): number {
  if (!pending) return 1;
  const raw = pending.volleyCount ?? pending.shotCount;
  return Math.max(1, Math.floor(Number(raw) || 1));
}

/**
 * Deck-gun firing panel — destroyer + fleet-sub surface engagement.
 * Designate + fire: relative aim / LOS, rough range, volleys (1–3). Optional
 * Contact N from optics prefills aim + range. Resolve acquires nearest surface
 * contact near the designate and applies crew lead; each volley is one AOE.
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
  writePending = false,
  opticsContacts = [],
  onSubmit,
  onClear,
  onReload,
}: Props) {
  const capacity = defaultDeckGunLoad({ class: hullClass, type: vesselType });
  const maxVolleys = maxDeckGunVolleysPerTurn({ class: hullClass, type: vesselType });
  const affordable = deckGunVolleysFromAmmo({ deckGunLoad });
  const [aimRelative, setAimRelative] = useState(() =>
    pending ? Math.round(relativeBearingDeg(ownHeading, pending.aimHeading)) : 0,
  );
  const [estimatedRangeNm, setEstimatedRangeNm] = useState(
    () => pending?.estimatedRangeNm ?? 0,
  );
  const [volleyCount, setVolleyCount] = useState(() => {
    const pendingN = pendingVolleyCount(pending);
    const cap = Math.max(1, Math.min(maxVolleys, Math.max(1, affordable || 1)));
    return Math.min(cap, Math.max(1, pendingN));
  });
  const [opticsPick, setOpticsPick] = useState('');

  const aimTrue = trueBearingFromRelative(ownHeading, aimRelative);
  // Preview only — resolve uses acquired-contact truth for lead; show stationary
  // fire = aim so the panel does not invent a player course/speed solution.
  const solution = torpedoFireHeadingFromSolution({
    aimHeading: aimTrue,
    estimatedCourse: 0,
    estimatedSpeedKn: 0,
    estimatedRangeNm,
    torpedoSpeedKn: DECK_GUN_SHELL_SPEED_KN,
  });
  const fireHeading = solution.fireHeading;

  const submerged =
    vesselType === 'Submarine' && keelDepthM > RADAR_SURFACE_DEPTH_M;
  const magBlocked =
    awaitingReload || reloadTurnsRemaining > 0 || deckGunLoad < DECK_GUN_SHELLS_PER_VOLLEY;
  const volleyCap = Math.max(1, Math.min(maxVolleys, Math.max(1, affordable)));
  const effectiveVolleys = Math.min(volleyCap, Math.max(1, Math.floor(volleyCount) || 1));
  const shellsCost = deckGunShellsForVolleys(effectiveVolleys);
  const canQueue =
    !disabled &&
    !magBlocked &&
    !submerged &&
    estimatedRangeNm > 0 &&
    estimatedRangeNm <= DECK_GUN_MAX_RANGE_NM &&
    effectiveVolleys >= 1 &&
    shellsCost <= deckGunLoad;

  let magStatus = `${deckGunLoad}/${capacity} shells · ${affordable} volley${affordable === 1 ? '' : 's'} ready`;
  if (reloadTurnsRemaining > 0) {
    magStatus = `reloading · ${reloadTurnsRemaining} turn${reloadTurnsRemaining === 1 ? '' : 's'} left · ${deckGunLoad}/${capacity} left`;
  } else if (awaitingReload) {
    magStatus = `awaiting reload · ${deckGunLoad}/${capacity} left`;
  } else if (deckGunLoad < DECK_GUN_SHELLS_PER_VOLLEY) {
    magStatus =
      deckGunLoad <= 0
        ? 'empty — umpire rearm'
        : `${deckGunLoad}/${capacity} shells — need ${DECK_GUN_SHELLS_PER_VOLLEY} for a volley`;
  }

  const inputsDisabled = disabled || magBlocked || submerged;

  const gunsGuideId = stationGuideIdFor(hullClass, 'guns');

  const applyOpticsContact = (labelKey: string) => {
    setOpticsPick(labelKey);
    if (!labelKey) return;
    const n = Number(labelKey);
    const c = opticsContacts.find((x) => x.labelN === n);
    if (!c) return;
    setAimRelative(Math.round(foldRelativeBearing(c.relativeBearing)));
    setEstimatedRangeNm(
      Math.min(DECK_GUN_MAX_RANGE_NM, Math.max(0, Math.round(c.rangeNm * 100) / 100)),
    );
  };

  return (
    <section className="panel stack controls-weapons-panel station-instrument-panel">
      <div className="station-instrument-head">
        {gunsGuideId ? (
          <StationInstrumentTitle title="Guns" guideId={gunsGuideId} />
        ) : (
          <h2>Guns</h2>
        )}
        <p className="muted station-instrument-blurb">
          {magStatus} · max {DECK_GUN_MAX_VOLLEYS_PER_TURN} volleys/turn ·{' '}
          {DECK_GUN_SHELLS_PER_VOLLEY} shells/volley · {DECK_GUN_MAX_RANGE_NM} nm · surface only ·
          reload {DECK_GUN_RELOAD_TURNS} turns · crew lead
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

      {opticsContacts.length > 0 && (
        <label className="stack" style={{ gap: '0.25rem' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            From optics (optional)
          </span>
          <select
            value={opticsPick}
            disabled={inputsDisabled}
            onChange={(e) => applyOpticsContact(e.target.value)}
            aria-label="Fill designate from optics Contact N"
          >
            <option value="">— Contact N —</option>
            {opticsContacts.map((c) => (
              <option key={c.labelN} value={String(c.labelN)}>
                {formatContactDesignation(c.labelN)} · {formatRelBearing(c.relativeBearing)} ·{' '}
                {c.rangeNm.toFixed(2)} nm
              </option>
            ))}
          </select>
        </label>
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
        Designate along LOS · Fire HDG preview {String(Math.round(fireHeading)).padStart(3, '0')}°
        (crew lead at resolve)
      </p>

      <TouchNumber
        label="Rough range"
        value={estimatedRangeNm}
        onChange={setEstimatedRangeNm}
        min={0}
        max={DECK_GUN_MAX_RANGE_NM}
        step={0.01}
        unit="nm"
        disabled={inputsDisabled}
      />
      <TouchNumber
        label="Volleys this turn"
        value={effectiveVolleys}
        onChange={(v) =>
          setVolleyCount(Math.min(volleyCap, Math.max(1, Math.floor(v) || 1)))
        }
        min={1}
        max={volleyCap}
        step={1}
        unit=""
        disabled={inputsDisabled}
      />
      <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        {DECK_GUN_SHELLS_PER_VOLLEY} rpm · {effectiveVolleys} volley
        {effectiveVolleys === 1 ? '' : 's'} · consumes {shellsCost} shells ·{' '}
        {Math.max(0, deckGunLoad - shellsCost)}/{capacity} left after fire
      </p>

      <div className="control-actions">
        <button
          className={['primary', writePending ? 'is-pending' : ''].filter(Boolean).join(' ')}
          type="button"
          disabled={!canQueue}
          aria-busy={writePending || undefined}
          onClick={() =>
            onSubmit({
              aimHeading: aimTrue,
              estimatedRangeNm,
              volleyCount: effectiveVolleys,
            })
          }
        >
          {writePending
            ? 'Queuing…'
            : `Queue deck-gun fire ×${effectiveVolleys} volley${effectiveVolleys === 1 ? '' : 's'}`}
        </button>
        {pending && onClear && (
          <button type="button" disabled={disabled} onClick={onClear}>
            Clear gun order
          </button>
        )}
      </div>

      {pending && (
        <p className="mono readout" style={{ margin: 0 }}>
          Submitted: {pendingVolleyCount(pending)} volley
          {pendingVolleyCount(pending) === 1 ? '' : 's'} · aim{' '}
          {String(Math.round(pending.aimHeading)).padStart(3, '0')}° ·{' '}
          {pending.estimatedRangeNm.toFixed(2)} nm (crew lead)
        </p>
      )}
    </section>
  );
}
