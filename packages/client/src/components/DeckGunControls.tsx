import { useState } from 'react';
import {
  DECK_GUN_MAX_RANGE_NM,
  DECK_GUN_MAX_VOLLEYS_PER_TURN,
  DECK_GUN_RELOAD_TURNS,
  DECK_GUN_SHELLS_PER_VOLLEY,
  RADAR_SURFACE_DEPTH_M,
  defaultDeckGunLoad,
  deckGunShellsForVolleys,
  deckGunVolleysFromAmmo,
  formatContactDesignation,
  formatDeckGunFireBlockNotice,
  maxDeckGunVolleysPerTurn,
  type DeckGunFireBlock,
  type DeckGunFireOrder,
  type HullClass,
  type VesselType,
} from '@war-patrol/shared';
import { formatRelBearing } from './OpticsBearingCompass';
import { StationInstrumentTitle } from './StationInfoButton';
import { stationGuideIdFor } from '../stationGuides';
import { TouchNumber } from './TouchNumber';

/** Optics / lookout hull contact available as a deck-gun target. */
export type DeckGunOpticsContact = {
  labelN: number;
  relativeBearing: number;
  rangeNm: number;
  speedKn?: number;
};

interface Props {
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
  /** Hull contacts currently reported by lookout / periscope (not feathers). */
  opticsContacts?: DeckGunOpticsContact[];
  onSubmit: (order: DeckGunFireOrder) => void;
  onClear?: () => void;
  onReload?: () => void;
}

function pendingVolleyCount(pending: DeckGunFireOrder | undefined): number {
  if (!pending) return 1;
  const raw = pending.volleyCount ?? pending.shotCount;
  return Math.max(1, Math.floor(Number(raw) || 1));
}

/**
 * Deck-gun firing panel — destroyer + fleet-sub surface engagement.
 * Pick an optics Contact N + volleys (1–3). Crew RNG resolves aim from true
 * range + target speed; no player aim / lead / bearing math.
 */
export function DeckGunControls({
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
  const [opticsPick, setOpticsPick] = useState(() =>
    pending?.targetLabelN != null && pending.targetLabelN >= 1
      ? String(pending.targetLabelN)
      : '',
  );
  const [volleyCount, setVolleyCount] = useState(() => {
    const pendingN = pendingVolleyCount(pending);
    const cap = Math.max(1, Math.min(maxVolleys, Math.max(1, affordable || 1)));
    return Math.min(cap, Math.max(1, pendingN));
  });

  const selectedLabelN = Math.floor(Number(opticsPick) || 0);
  const selected = opticsContacts.find((c) => c.labelN === selectedLabelN);

  const submerged =
    vesselType === 'Submarine' && keelDepthM > RADAR_SURFACE_DEPTH_M;
  const magBlocked =
    awaitingReload || reloadTurnsRemaining > 0 || deckGunLoad < DECK_GUN_SHELLS_PER_VOLLEY;
  const volleyCap = Math.max(1, Math.min(maxVolleys, Math.max(1, affordable)));
  const effectiveVolleys = Math.min(volleyCap, Math.max(1, Math.floor(volleyCount) || 1));
  const shellsCost = deckGunShellsForVolleys(effectiveVolleys);
  const rangeOk =
    selected != null &&
    selected.rangeNm > 0 &&
    selected.rangeNm <= DECK_GUN_MAX_RANGE_NM;
  const canQueue =
    !disabled &&
    !magBlocked &&
    !submerged &&
    selected != null &&
    rangeOk &&
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
          reload {DECK_GUN_RELOAD_TURNS} turns · optics target · crew RNG
        </p>
      </div>

      {fireBlock && (
        <p className="mono readout" style={{ margin: 0, color: 'var(--warn)' }}>
          {formatDeckGunFireBlockNotice(fireBlock)}
        </p>
      )}

      {submerged && (
        <p className="mono readout" style={{ margin: 0, color: 'var(--warn)' }}>
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

      <label className="stack" style={{ gap: '0.25rem' }}>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          Optics contact
        </span>
        <select
          value={opticsPick}
          disabled={inputsDisabled || opticsContacts.length === 0}
          onChange={(e) => setOpticsPick(e.target.value)}
          aria-label="Select optics contact to engage"
        >
          <option value="">
            {opticsContacts.length === 0 ? '— no optics contacts —' : '— select contact —'}
          </option>
          {opticsContacts.map((c) => (
            <option key={c.labelN} value={String(c.labelN)}>
              {formatContactDesignation(c.labelN)} · {formatRelBearing(c.relativeBearing)} ·{' '}
              {c.rangeNm.toFixed(2)} nm
              {c.speedKn != null && Number.isFinite(c.speedKn)
                ? ` · ${c.speedKn.toFixed(1)} kn`
                : ''}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p className="mono muted" style={{ margin: 0, fontSize: '0.85rem' }}>
          Crew solves lead from range + speed — no player aim
        </p>
      )}

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
          onClick={() => {
            if (!selected) return;
            onSubmit({
              targetLabelN: selected.labelN,
              volleyCount: effectiveVolleys,
            });
          }}
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
          {pendingVolleyCount(pending) === 1 ? '' : 's'} ·{' '}
          {formatContactDesignation(pending.targetLabelN)} (crew RNG)
        </p>
      )}
    </section>
  );
}
