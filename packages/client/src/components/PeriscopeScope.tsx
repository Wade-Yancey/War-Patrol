import { memo, useMemo, useState } from 'react';
import {
  formatContactDesignation,
  formatPeriscopeDesignation,
  normalizeHeading,
  opticsSightingLabel,
  periscopeSilhouetteFlipX,
  periscopeSilhouetteScale,
  type HullClass,
  type OpticsDamageLook,
  type OpticsSighting,
  type PeriscopeContact,
} from '@war-patrol/shared';
/** Vite-bundled PNGs (alpha) — guaranteed in the client graph (not fragile public-path strings). */
import carrierSilhouettePng from '../assets/silhouettes/carrier.png';
import destroyerSilhouettePng from '../assets/silhouettes/destroyer.png';
import kageroSilhouettePng from '../assets/silhouettes/kagero.png';
import oilerSilhouettePng from '../assets/silhouettes/oiler.png';
import submarineSilhouettePng from '../assets/silhouettes/submarine.png';
import zekeSilhouettePng from '../assets/silhouettes/zeke.png';
import {
  formatRelBearing,
  formatTrueBearing,
  OpticsBearingCompass,
} from './OpticsBearingCompass';
import { PeriscopeFeatherSvg } from './PeriscopeFeatherSvg';

interface Props {
  contacts: PeriscopeContact[];
  /**
   * Lookout / periscope FoW Sightings (wake + sink aftermath) — selectable
   * like contacts; {@link OpticsSighting.relativeBearing} drives the compass.
   */
  sightings?: OpticsSighting[];
  maxRangeNm: number;
  /** Own-ship heading — solid HDG needle (bow facing) on the north-up rose. */
  ownHeading: number;
  /**
   * Sub periscope vs surface-ship lookout — same FoW / silhouette / contact list.
   * Only affects operator-facing labels in the optics CRT.
   */
  variant?: 'periscope' | 'lookout';
  /**
   * Scope-down / optically blind — clears viewer + contacts; compass stays idle.
   */
  blind?: boolean;
}

/** Shared selection — contacts and sightings share the optics compass. */
type OpticsSelection =
  | { kind: 'contact'; id: string }
  | { kind: 'sighting'; id: string };

/** Intrinsic pixel size for the plate `<img>` (matches source PNG). */
const SILHOUETTE_SIZE: Record<string, { width: number; height: number }> = {
  Destroyer: { width: 349, height: 79 },
  kagero: { width: 353, height: 79 },
  'Fleet Submarine': { width: 350, height: 55 },
  Oiler: { width: 510, height: 98 },
  'Aircraft Carrier': { width: 720, height: 87 },
  zeke: { width: 655, height: 482 },
};

/**
 * Class / plate → Vite-bundled asset. Mirrors `silhouetteUrlForOptics` in shared
 * (public `/silhouettes/*.png` for verify; bundled import for the CRT).
 */
function silhouetteSrcForContact(
  hullClass: HullClass | string | undefined,
  plate: string | undefined,
): string {
  if (plate === 'kagero') return kageroSilhouettePng;
  if (plate === 'zeke') return zekeSilhouettePng;
  switch (hullClass) {
    case 'Fleet Submarine':
      return submarineSilhouettePng;
    case 'Oiler':
      return oilerSilhouettePng;
    case 'Aircraft Carrier':
      return carrierSilhouettePng;
    case 'Destroyer':
    default:
      return destroyerSilhouettePng;
  }
}

function silhouetteAlt(
  hullClass: HullClass | string | undefined,
  plate: string | undefined,
): string {
  if (plate === 'kagero') return 'Kagerō destroyer silhouette';
  if (plate === 'zeke') return 'Mitsubishi Zeke fighter silhouette';
  if (hullClass === 'Fleet Submarine') return 'Submarine silhouette';
  if (hullClass === 'Oiler') return 'Oiler silhouette';
  if (hullClass === 'Aircraft Carrier') return 'Aircraft carrier silhouette';
  return 'Destroyer silhouette';
}

/** Top-down airframe plates (nose-up) — distinct CSS sizing from side-profile hulls. */
function isAirSilhouettePlate(
  hullClass: HullClass | string | undefined,
  plate: string | undefined,
): boolean {
  if (plate === 'zeke') return true;
  return hullClass === 'Fighter' || hullClass === 'Bomber';
}

function contactDesignation(c: PeriscopeContact): string {
  return c.kind === 'periscope'
    ? formatPeriscopeDesignation(c.labelN)
    : formatContactDesignation(c.labelN);
}

/**
 * Additive CSS modifier for the existing plate `<img>` — filter/opacity only.
 * Priority: sinking > smoking > scarred. Never wraps, clips, or tilts the plate.
 */
function silhouetteDamageClass(
  sinking: boolean | undefined,
  damageLook: OpticsDamageLook | undefined,
): string {
  if (sinking) return ' periscope-silhouette--sinking';
  if (damageLook === 'smoking') return ' periscope-silhouette--smoking';
  if (damageLook === 'scarred') return ' periscope-silhouette--scarred';
  return '';
}

/** Precise true course readout — padded like own HDG readout. */
function formatCourse(courseDeg: number): string {
  return `${String(Math.round(courseDeg) % 360).padStart(3, '0')}°`;
}

/** Selected-contact / sighting true bearing from own HDG + relative LOS. */
function contactTrueBearing(ownHeading: number, relativeBearing: number): string {
  return formatTrueBearing(normalizeHeading(ownHeading + relativeBearing));
}

/** Wake travel secondary — distinct from sighting/contact REL (port/stbd look-at). */
function formatWakeTravel(rel: number): string {
  if (rel === 0) return 'running ahead';
  if (Math.abs(rel) === 180) return 'running astern';
  const abs = Math.abs(rel);
  const side = rel > 0 ? 'stbd' : 'port';
  return `running ${String(abs).padStart(3, '0')}° ${side}`;
}

function contactsKey(contacts: PeriscopeContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.kind ?? 'hull'}:${c.sinking ? 's' : ''}:${c.damageLook ?? ''}`,
    )
    .join('|');
}

function sightingsKey(sightings: OpticsSighting[]): string {
  return sightings
    .map(
      (s) =>
        `${s.id}:${s.kind}:${s.relativeBearing}:${s.travelRelativeBearing ?? ''}:${s.confidence ?? ''}`,
    )
    .join('|');
}

/**
 * Shared visual optics CRT — one desktop row:
 * helm-style bearing compass (left) · silhouette viewer (center) · contact table (right).
 *
 * Used for fleet-sub periscope and surface-ship lookout. Destroyer / ship
 * contacts → `destroyer.png`; Fleet Submarine hull contacts → `submarine.png`.
 * DD lookout periscope feathers (`kind: 'periscope'`) → stick/feather SVG (not a hull plate).
 * Unknown classes fall back to the destroyer plate. CRT grain/scanline overlay
 * sits above the optics without hiding alpha.
 *
 * Layout/silhouette rendering stays on the pre-#186 flex-centered plate model
 * (no plate-wrap waterline seating, sink-clip/list, or scar/smoke overlays).
 * `sinking` / `damageLook` keep status text; the plate itself gets additive
 * filter/opacity modifiers only (no layout shift).
 */
function PeriscopeScopeInner({
  contacts,
  sightings = [],
  maxRangeNm,
  ownHeading,
  variant = 'periscope',
  blind = false,
}: Props) {
  const sorted = useMemo(() => {
    if (blind) return [];
    return [...contacts].sort(
      (a, b) =>
        Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing) || a.rangeNm - b.rangeNm,
    );
  }, [blind, contacts]);

  const sortedSightings = useMemo(() => {
    if (blind) return [];
    return [...sightings].sort(
      (a, b) => Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing),
    );
  }, [blind, sightings]);

  const [selection, setSelection] = useState<OpticsSelection | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Synchronous selection — prefer retained pick; else first contact, else first sighting.
  const effectiveSelection: OpticsSelection | null = (() => {
    if (blind) return null;
    if (selection?.kind === 'contact' && sorted.some((c) => c.id === selection.id)) {
      return selection;
    }
    if (selection?.kind === 'sighting' && sortedSightings.some((s) => s.id === selection.id)) {
      return selection;
    }
    if (sorted[0]) return { kind: 'contact', id: sorted[0].id };
    if (sortedSightings[0]) return { kind: 'sighting', id: sortedSightings[0].id };
    return null;
  })();

  const selected =
    effectiveSelection?.kind === 'contact'
      ? (sorted.find((c) => c.id === effectiveSelection.id) ?? null)
      : null;
  const selectedSighting =
    effectiveSelection?.kind === 'sighting'
      ? (sortedSightings.find((s) => s.id === effectiveSelection.id) ?? null)
      : null;

  const compassRel =
    selectedSighting?.relativeBearing ?? selected?.relativeBearing ?? null;

  const viewportLabel =
    variant === 'lookout' ? 'Lookout visual contact' : 'Periscope visual contact';
  const isFeather = selected?.kind === 'periscope';

  const plateClass = selected?.silhouetteClass;
  const plateKey = selected?.silhouettePlate;
  const plateSrc = silhouetteSrcForContact(plateClass, plateKey);
  const airPlate = isAirSilhouettePlate(plateClass, plateKey);
  // Same range falloff as hull plates (`periscopeSilhouetteScale`). Air top-downs
  // use the full 0.25–1 curve; thin side-profiles keep a 0.55 readability floor.
  const rawScale = selected
    ? periscopeSilhouetteScale(selected.rangeNm, maxRangeNm)
    : 1;
  const scale = selected ? (airPlate ? rawScale : Math.max(rawScale, 0.55)) : 1;
  const plateSize =
    (plateKey ? SILHOUETTE_SIZE[plateKey] : undefined) ??
    SILHOUETTE_SIZE[plateClass ?? ''] ??
    SILHOUETTE_SIZE.Destroyer;
  // Hull plates: bow-right, flip for port AOB. Air top-downs (nose-up): same
  // flip helper mirrors left/right for port aspect (no separate heading rotate).
  const flipPlate =
    !isFeather &&
    selected != null &&
    periscopeSilhouetteFlipX(ownHeading, selected.relativeBearing, selected.courseDeg);

  const hasVisual = sorted.length > 0 || sortedSightings.length > 0;

  return (
    <div className="radar-scope radar-console periscope-scope">
      <div className="periscope-compass-col">
        <OpticsBearingCompass relativeBearing={compassRel} ownHeading={ownHeading} />
      </div>

      <div
        className={`periscope-viewport${blind ? ' periscope-viewport--blind' : ''}`}
        aria-label={viewportLabel}
      >
        {!blind && (
          <>
            <div className="periscope-horizon" aria-hidden />
            <div className="periscope-sea" aria-hidden />
          </>
        )}

        {blind ? (
          <p className="periscope-empty mono periscope-empty--blind">Scope down</p>
        ) : !hasVisual ? (
          <p className="periscope-empty mono muted">No visual contacts within {maxRangeNm} nm</p>
        ) : selectedSighting ? (
          <div className="periscope-selected periscope-selected--sighting">
            <div className="periscope-readouts mono">
              <span className="readout">{opticsSightingLabel(selectedSighting.kind)}</span>
              {/*
                Fire-control order (matches torpedo / deck-gun calculators):
                bearing (rel + true) → then wake extras. No range/crs/kn on sightings.
              */}
              <div className="periscope-readouts-meta">
                <span className="periscope-meta-bearing">
                  <span className="periscope-meta-bearing-key">rel</span>{' '}
                  {formatRelBearing(selectedSighting.relativeBearing)}
                </span>
                <span className="periscope-meta-bearing">
                  <span className="periscope-meta-bearing-key">true</span>{' '}
                  {contactTrueBearing(ownHeading, selectedSighting.relativeBearing)}
                </span>
                {selectedSighting.kind === 'wake' &&
                  selectedSighting.travelRelativeBearing != null && (
                    <span className="muted">
                      {formatWakeTravel(selectedSighting.travelRelativeBearing)}
                    </span>
                  )}
                {selectedSighting.kind === 'wake' && selectedSighting.confidence && (
                  <span className="muted">{selectedSighting.confidence.toUpperCase()}</span>
                )}
              </div>
            </div>
          </div>
        ) : selected ? (
          <div
            className="periscope-selected"
            style={{ ['--peri-scale' as string]: String(scale) }}
          >
            {isFeather ? (
              <PeriscopeFeatherSvg className="periscope-feather" />
            ) : imgFailed ? (
              <p className="periscope-img-error mono" role="alert">
                Silhouette failed to load
              </p>
            ) : (
              <img
                key={plateSrc}
                className={`periscope-silhouette${airPlate ? ' periscope-silhouette--air' : ''}${flipPlate ? ' periscope-silhouette--flip' : ''}${silhouetteDamageClass(selected.sinking, selected.damageLook)}`}
                src={plateSrc}
                alt={silhouetteAlt(plateClass, plateKey)}
                width={plateSize.width}
                height={plateSize.height}
                decoding="sync"
                loading="eager"
                draggable={false}
                onError={() => setImgFailed(true)}
                onLoad={() => setImgFailed(false)}
              />
            )}
            <div className="periscope-readouts mono">
              <span className="readout">
                {isFeather
                  ? formatPeriscopeDesignation(selected.labelN)
                  : formatContactDesignation(selected.labelN)}
              </span>
              {/*
                Fire-control order (matches torpedo / deck-gun calculators):
                bearing (rel + true) → range → course → speed → status chips.
                Fixed-height slot (CSS) so wrap/chips cannot shove the plate.
              */}
              <div className="periscope-readouts-meta">
                <span className="periscope-meta-bearing">
                  <span className="periscope-meta-bearing-key">rel</span>{' '}
                  {formatRelBearing(selected.relativeBearing)}
                </span>
                <span className="periscope-meta-bearing">
                  <span className="periscope-meta-bearing-key">true</span>{' '}
                  {contactTrueBearing(ownHeading, selected.relativeBearing)}
                </span>
                <span className="muted">{selected.rangeNm.toFixed(2)} nm</span>
                {!isFeather &&
                  selected.courseDeg != null &&
                  Number.isFinite(selected.courseDeg) && (
                    <span className="muted">crs {formatCourse(selected.courseDeg)}</span>
                  )}
                {!isFeather && (
                  <span className="muted">{selected.speedKn.toFixed(1)} kn</span>
                )}
                {!isFeather && selected.sinking && (
                  <span className="periscope-status-chip periscope-status-chip--sinking">
                    sinking
                  </span>
                )}
                {!isFeather &&
                  !selected.sinking &&
                  selected.damageLook === 'smoking' && (
                    <span className="periscope-status-chip periscope-status-chip--smoke">
                      smoke
                    </span>
                  )}
                {!isFeather &&
                  !selected.sinking &&
                  selected.damageLook === 'scarred' && (
                    <span className="periscope-status-chip periscope-status-chip--scar">
                      scar
                    </span>
                  )}
              </div>
            </div>
          </div>
        ) : null}

        {/* Subtle CRT grain + scanlines — above optics, pointer-events none, low opacity.
            Hidden when blind so the viewer stays solid black (no sky/sea / stale picture). */}
        {!blind && (
          <div className="periscope-crt-overlay" aria-hidden>
            <div className="periscope-scanlines" />
            <div className="periscope-grain" />
          </div>
        )}
      </div>

      <aside className="radar-side-panel periscope-side-panel">
        <p className="mono muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          VIS · {maxRangeNm} nm · HDG {String(Math.round(ownHeading) % 360).padStart(3, '0')}°
          {blind ? ' · BLIND' : ''}
        </p>
        <div className="radar-contact-list">
          <h3 className="radar-contacts-heading">Contacts</h3>
          {sorted.length === 0 ? (
            <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
              {blind ? 'Blind' : 'Clear'}
            </p>
          ) : (
            <ul className="sensor-contact-scroll">
              {sorted.map((c) => {
                const active =
                  effectiveSelection?.kind === 'contact' && c.id === effectiveSelection.id;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`periscope-contact-btn mono${active ? ' primary' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setImgFailed(false);
                        setSelection({ kind: 'contact', id: c.id });
                      }}
                    >
                      <span className="readout">{contactDesignation(c)}</span>
                      <span className="radar-contact-meta">
                        <span>{formatRelBearing(c.relativeBearing)}</span>
                        <span>{c.rangeNm.toFixed(2)} nm</span>
                        {c.kind !== 'periscope' &&
                          c.courseDeg != null &&
                          Number.isFinite(c.courseDeg) && (
                            <span>crs {formatCourse(c.courseDeg)}</span>
                          )}
                        {c.kind !== 'periscope' && <span>{c.speedKn.toFixed(1)} kn</span>}
                        {c.kind !== 'periscope' && c.sinking && (
                          <span className="periscope-status-chip periscope-status-chip--sinking">
                            sinking
                          </span>
                        )}
                        {c.kind !== 'periscope' &&
                          !c.sinking &&
                          c.damageLook === 'smoking' && (
                            <span className="periscope-status-chip periscope-status-chip--smoke">
                              smoke
                            </span>
                          )}
                        {c.kind !== 'periscope' &&
                          !c.sinking &&
                          c.damageLook === 'scarred' && (
                            <span className="periscope-status-chip periscope-status-chip--scar">
                              scar
                            </span>
                          )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {!blind && sortedSightings.length > 0 && (
          <div className="radar-contact-list periscope-sightings-list">
            <h3 className="radar-contacts-heading">Sightings</h3>
            <ul className="sensor-contact-scroll">
              {sortedSightings.map((s) => {
                const active =
                  effectiveSelection?.kind === 'sighting' && s.id === effectiveSelection.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`periscope-contact-btn mono${active ? ' primary' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setImgFailed(false);
                        setSelection({ kind: 'sighting', id: s.id });
                      }}
                    >
                      <span className="readout">{opticsSightingLabel(s.kind)}</span>
                      <span className="radar-contact-meta">
                        <span>{formatRelBearing(s.relativeBearing)}</span>
                        {s.kind === 'wake' && s.travelRelativeBearing != null && (
                          <span>{formatWakeTravel(s.travelRelativeBearing)}</span>
                        )}
                        {s.kind === 'wake' && s.confidence && (
                          <span>{s.confidence.toUpperCase()}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {blind && <p className="periscope-caption muted">Mast lowered</p>}
      </aside>
    </div>
  );
}

export const PeriscopeScope = memo(PeriscopeScopeInner, (prev, next) => {
  const prevSightings = prev.sightings ?? [];
  const nextSightings = next.sightings ?? [];
  return (
    prev.maxRangeNm === next.maxRangeNm &&
    prev.ownHeading === next.ownHeading &&
    prev.variant === next.variant &&
    prev.blind === next.blind &&
    contactsKey(prev.contacts) === contactsKey(next.contacts) &&
    prev.contacts.length === next.contacts.length &&
    prev.contacts.every((c, i) => {
      const o = next.contacts[i];
      return (
        o &&
        c.id === o.id &&
        c.relativeBearing === o.relativeBearing &&
        c.rangeNm === o.rangeNm &&
        c.speedKn === o.speedKn &&
        c.courseDeg === o.courseDeg &&
        c.silhouetteClass === o.silhouetteClass &&
        c.silhouettePlate === o.silhouettePlate &&
        (c.kind ?? 'hull') === (o.kind ?? 'hull') &&
        Boolean(c.sinking) === Boolean(o.sinking) &&
        (c.damageLook ?? '') === (o.damageLook ?? '')
      );
    }) &&
    sightingsKey(prevSightings) === sightingsKey(nextSightings) &&
    prevSightings.length === nextSightings.length
  );
});
