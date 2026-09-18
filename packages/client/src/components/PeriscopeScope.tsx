import { memo, useEffect, useMemo, useState } from 'react';
import {
  periscopeSilhouetteScale,
  silhouetteUrlForClass,
  type PeriscopeContact,
} from '@war-patrol/shared';

interface Props {
  contacts: PeriscopeContact[];
  maxRangeNm: number;
  /** Own-ship heading — lubber / bow reference only. */
  ownHeading: number;
}

function formatRelBearing(rel: number): string {
  if (rel === 0) return '000° rel';
  const abs = Math.abs(rel);
  const side = rel > 0 ? 'stbd' : 'port';
  return `${String(abs).padStart(3, '0')}° ${side}`;
}

function contactsKey(contacts: PeriscopeContact[]): string {
  return contacts.map((c) => c.id).join('|');
}

/**
 * Periscope CRT — silhouette viewer (left) + anonymous Contact N list (right).
 * Click a contact to show its silhouette and coarsened readouts.
 */
function PeriscopeScopeInner({ contacts, maxRangeNm, ownHeading }: Props) {
  const sorted = useMemo(
    () =>
      [...contacts].sort(
        (a, b) =>
          Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing) || a.rangeNm - b.rangeNm,
      ),
    [contacts],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (sorted.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) =>
      prev && sorted.some((c) => c.id === prev) ? prev : sorted[0]!.id,
    );
  }, [sorted]);

  const selected = useMemo(
    () => sorted.find((c) => c.id === selectedId) ?? null,
    [sorted, selectedId],
  );

  const selectedIndex = selected ? sorted.findIndex((c) => c.id === selected.id) : -1;
  const selectedLabelN = selectedIndex >= 0 ? selectedIndex + 1 : null;

  const scale = selected ? periscopeSilhouetteScale(selected.rangeNm, maxRangeNm) : 1;
  const url = selected ? silhouetteUrlForClass(selected.silhouetteClass) : null;

  return (
    <div className="radar-scope radar-console periscope-scope">
      <div className="periscope-viewport" role="img" aria-label="Periscope visual contact">
        <div className="periscope-horizon" />
        <div className="periscope-sea" />
        <div className="periscope-reticule" aria-hidden>
          <span className="periscope-cross periscope-cross--h" />
          <span className="periscope-cross periscope-cross--v" />
          <span className="periscope-bow-mark">BOW</span>
        </div>
        {sorted.length === 0 ? (
          <p className="periscope-empty mono muted">No visual contacts within {maxRangeNm} nm</p>
        ) : selected ? (
          <div
            className="periscope-selected"
            style={{ ['--peri-scale' as string]: String(scale) }}
          >
            {url ? (
              <img
                className="periscope-silhouette"
                src={url}
                alt=""
                draggable={false}
              />
            ) : (
              <div
                className="periscope-silhouette periscope-silhouette--missing"
                title="No silhouette"
              >
                <span className="mono">?</span>
              </div>
            )}
            <div className="periscope-readouts mono">
              <span className="readout">Contact {selectedLabelN}</span>
              <span>{formatRelBearing(selected.relativeBearing)}</span>
              <span className="muted">~{selected.rangeNm.toFixed(1)} nm</span>
              <span className="muted">~{selected.speedKn} kn</span>
            </div>
          </div>
        ) : null}
      </div>

      <aside className="radar-side-panel periscope-side-panel">
        <p className="mono muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          VIS · {maxRangeNm} nm · HDG {String(Math.round(ownHeading) % 360).padStart(3, '0')}°
        </p>
        <div className="radar-contact-list">
          <h3 className="radar-contacts-heading">Contacts</h3>
          {sorted.length === 0 ? (
            <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
              Clear
            </p>
          ) : (
            <ul className="sensor-contact-scroll">
              {sorted.map((c, i) => {
                const active = c.id === selectedId;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      className={`periscope-contact-btn mono${active ? ' primary' : ''}`}
                      aria-pressed={active}
                      onClick={() => setSelectedId(c.id)}
                    >
                      <span className="readout">Contact {i + 1}</span>
                      <span className="radar-contact-meta">
                        <span>{formatRelBearing(c.relativeBearing)}</span>
                        <span>~{c.rangeNm.toFixed(1)} nm</span>
                        <span>~{c.speedKn} kn</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <p className="periscope-caption muted">
          Silhouette only — class image when available. Range scales size (farther = smaller).
        </p>
      </aside>
    </div>
  );
}

export const PeriscopeScope = memo(PeriscopeScopeInner, (prev, next) => {
  return (
    prev.maxRangeNm === next.maxRangeNm &&
    prev.ownHeading === next.ownHeading &&
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
        c.silhouetteClass === o.silhouetteClass
      );
    })
  );
});
