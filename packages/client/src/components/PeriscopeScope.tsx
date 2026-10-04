import { memo, useMemo, useState } from 'react';
import {
  formatContactDesignation,
  formatPeriscopeDesignation,
  periscopeSilhouetteFlipX,
  periscopeSilhouetteScale,
  type HullClass,
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
  OpticsBearingCompass,
} from './OpticsBearingCompass';
import { PeriscopeFeatherSvg } from './PeriscopeFeatherSvg';

interface Props {
  contacts: PeriscopeContact[];
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

/** Precise true course readout — padded like own HDG readout. */
function formatCourse(courseDeg: number): string {
  return `${String(Math.round(courseDeg) % 360).padStart(3, '0')}°`;
}

function contactsKey(contacts: PeriscopeContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.kind ?? 'hull'}:${c.sinking ? 's' : ''}:${c.damageLook ?? ''}`,
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
 */
function PeriscopeScopeInner({
  contacts,
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // Synchronous selection — no useEffect gap where contacts exist but img never mounts.
  const effectiveId =
    !blind && selectedId != null && sorted.some((c) => c.id === selectedId)
      ? selectedId
      : (sorted[0]?.id ?? null);

  const selected = effectiveId ? (sorted.find((c) => c.id === effectiveId) ?? null) : null;

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

  return (
    <div className="radar-scope radar-console periscope-scope">
      <div className="periscope-compass-col">
        <OpticsBearingCompass
          relativeBearing={selected ? selected.relativeBearing : null}
          ownHeading={ownHeading}
        />
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
        ) : sorted.length === 0 ? (
          <p className="periscope-empty mono muted">No visual contacts within {maxRangeNm} nm</p>
        ) : selected ? (
          <div
            className={`periscope-selected${
              !isFeather && selected.sinking ? ' periscope-selected--sinking' : ''
            }`}
            style={{ ['--peri-scale' as string]: String(scale) }}
          >
            {isFeather ? (
              <PeriscopeFeatherSvg className="periscope-feather" />
            ) : imgFailed ? (
              <p className="periscope-img-error mono" role="alert">
                Silhouette failed to load
              </p>
            ) : (
              <div
                className={`periscope-plate-wrap${
                  selected.sinking ? ' periscope-plate-wrap--sinking' : ''
                }${
                  selected.damageLook
                    ? ` periscope-plate-wrap--${selected.damageLook}`
                    : ''
                }`}
              >
                <img
                  key={plateSrc}
                  className={`periscope-silhouette${airPlate ? ' periscope-silhouette--air' : ''}${
                    flipPlate ? ' periscope-silhouette--flip' : ''
                  }${selected.sinking ? ' periscope-silhouette--sinking' : ''}${
                    selected.damageLook
                      ? ` periscope-silhouette--${selected.damageLook}`
                      : ''
                  }`}
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
                {selected.damageLook === 'smoking' && (
                  <div className="periscope-damage-smoke" aria-hidden />
                )}
                {selected.damageLook === 'scarred' && (
                  <div className="periscope-damage-scar" aria-hidden />
                )}
              </div>
            )}
            <div className="periscope-readouts mono">
              <span className="readout">
                {isFeather
                  ? formatPeriscopeDesignation(selected.labelN)
                  : formatContactDesignation(selected.labelN)}
              </span>
              <span>{formatRelBearing(selected.relativeBearing)}</span>
              <span className="muted">{selected.rangeNm.toFixed(2)} nm</span>
              {!isFeather && <span className="muted">{selected.speedKn.toFixed(1)} kn</span>}
              {!isFeather &&
                selected.courseDeg != null &&
                Number.isFinite(selected.courseDeg) && (
                  <span className="muted">crs {formatCourse(selected.courseDeg)}</span>
                )}
              {!isFeather && selected.sinking && (
                <span className="muted">sinking</span>
              )}
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
                const active = c.id === effectiveId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`periscope-contact-btn mono${active ? ' primary' : ''}`}
                      aria-pressed={active}
                      onClick={() => {
                        setImgFailed(false);
                        setSelectedId(c.id);
                      }}
                    >
                      <span className="readout">{contactDesignation(c)}</span>
                      <span className="radar-contact-meta">
                        <span>{formatRelBearing(c.relativeBearing)}</span>
                        <span>{c.rangeNm.toFixed(2)} nm</span>
                        {c.kind !== 'periscope' && <span>{c.speedKn.toFixed(1)} kn</span>}
                        {c.kind !== 'periscope' &&
                          c.courseDeg != null &&
                          Number.isFinite(c.courseDeg) && (
                            <span>crs {formatCourse(c.courseDeg)}</span>
                          )}
                        {c.kind !== 'periscope' && c.sinking && <span>sinking</span>}
                        {c.kind !== 'periscope' && c.damageLook === 'smoking' && (
                          <span>smoke</span>
                        )}
                        {c.kind !== 'periscope' && c.damageLook === 'scarred' && !c.sinking && (
                          <span>scar</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {blind && <p className="periscope-caption muted">Mast lowered</p>}
      </aside>
    </div>
  );
}

export const PeriscopeScope = memo(PeriscopeScopeInner, (prev, next) => {
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
    })
  );
});
