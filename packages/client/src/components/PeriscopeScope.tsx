import { memo, useMemo, useState } from 'react';
import {
  periscopeSilhouetteScale,
  type HullClass,
  type PeriscopeContact,
} from '@war-patrol/shared';
/** Vite-bundled PNGs (alpha) — guaranteed in the client graph (not fragile public-path strings). */
import destroyerSilhouettePng from '../assets/silhouettes/destroyer.png';
import submarineSilhouettePng from '../assets/silhouettes/submarine.png';
import {
  formatRelBearing,
  OpticsBearingCompass,
} from './OpticsBearingCompass';

interface Props {
  contacts: PeriscopeContact[];
  maxRangeNm: number;
  /** Own-ship heading — lubber / bow reference only. */
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
  'Fleet Submarine': { width: 350, height: 55 },
};

/**
 * Class → Vite-bundled plate. Mirrors `silhouetteUrlForClass` in shared
 * (public `/silhouettes/*.png` for verify; bundled import for the CRT).
 */
function silhouetteSrcForClass(hullClass: HullClass | string | undefined): string {
  switch (hullClass) {
    case 'Fleet Submarine':
      return submarineSilhouettePng;
    case 'Destroyer':
    default:
      return destroyerSilhouettePng;
  }
}

function silhouetteAlt(hullClass: HullClass | string | undefined): string {
  return hullClass === 'Fleet Submarine' ? 'Submarine silhouette' : 'Destroyer silhouette';
}

function contactKindLabel(c: PeriscopeContact): string {
  return c.kind === 'periscope' ? 'PERISCOPE' : `Contact`;
}

function contactsKey(contacts: PeriscopeContact[]): string {
  return contacts.map((c) => `${c.id}:${c.kind ?? 'hull'}`).join('|');
}

/**
 * Shared visual optics CRT — one desktop row:
 * relative-bearing compass (left) · silhouette viewer (center) · contact table (right).
 *
 * Used for fleet-sub periscope and surface-ship lookout. Destroyer / ship
 * contacts → `destroyer.png`; Fleet Submarine contacts → `submarine.png`.
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
  const selectedIndex = selected ? sorted.findIndex((c) => c.id === selected.id) : -1;
  const selectedLabelN = selectedIndex >= 0 ? selectedIndex + 1 : null;

  const scale = selected ? Math.max(periscopeSilhouetteScale(selected.rangeNm, maxRangeNm), 0.55) : 1;
  const viewportLabel =
    variant === 'lookout' ? 'Lookout visual contact' : 'Periscope visual contact';
  const isFeather = selected?.kind === 'periscope';

  const plateClass = selected?.silhouetteClass;
  const plateSrc = silhouetteSrcForClass(plateClass);
  const plateSize = SILHOUETTE_SIZE[plateClass ?? ''] ?? SILHOUETTE_SIZE.Destroyer;

  return (
    <div className="radar-scope radar-console periscope-scope">
      <div className="periscope-compass-col">
        <OpticsBearingCompass
          relativeBearing={selected ? selected.relativeBearing : null}
          ownHeading={ownHeading}
        />
      </div>

      <div className="periscope-viewport" aria-label={viewportLabel}>
        <div className="periscope-horizon" aria-hidden />
        <div className="periscope-sea" aria-hidden />

        {blind ? (
          <p className="periscope-empty mono muted">Periscope down — no visual</p>
        ) : sorted.length === 0 ? (
          <p className="periscope-empty mono muted">No visual contacts within {maxRangeNm} nm</p>
        ) : selected ? (
          <div
            className="periscope-selected"
            style={{ ['--peri-scale' as string]: String(scale) }}
          >
            {imgFailed ? (
              <p className="periscope-img-error mono" role="alert">
                Silhouette failed to load
              </p>
            ) : (
              <img
                key={plateSrc}
                className="periscope-silhouette"
                src={plateSrc}
                alt={silhouetteAlt(plateClass)}
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
                  ? 'PERISCOPE'
                  : `Contact ${selectedLabelN}`}
              </span>
              <span>{formatRelBearing(selected.relativeBearing)}</span>
              <span className="muted">~{selected.rangeNm.toFixed(1)} nm</span>
              {!isFeather && <span className="muted">~{selected.speedKn} kn</span>}
            </div>
          </div>
        ) : null}

        {/* Subtle CRT grain + scanlines — above optics, pointer-events none, low opacity. */}
        <div className="periscope-crt-overlay" aria-hidden>
          <div className="periscope-scanlines" />
          <div className="periscope-grain" />
        </div>
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
              {sorted.map((c, i) => {
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
                      <span className="readout">
                        {c.kind === 'periscope'
                          ? 'PERISCOPE'
                          : `${contactKindLabel(c)} ${i + 1}`}
                      </span>
                      <span className="radar-contact-meta">
                        <span>{formatRelBearing(c.relativeBearing)}</span>
                        <span>~{c.rangeNm.toFixed(1)} nm</span>
                        {c.kind !== 'periscope' && <span>~{c.speedKn} kn</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="periscope-caption muted">
          {blind
            ? 'Mast lowered — raise to clear silhouettes and contacts. Compass idle.'
            : 'Silhouette photo when a contact is selected. Range scales size (farther = smaller).'}
        </p>
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
        c.silhouetteClass === o.silhouetteClass &&
        (c.kind ?? 'hull') === (o.kind ?? 'hull')
      );
    })
  );
});
