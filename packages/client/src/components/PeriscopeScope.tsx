import { memo, useMemo } from 'react';
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

/**
 * Periscope CRT — short-range silhouettes scaled by range, coarsened bearing/speed.
 * Tablet-friendly; no PPI blips; own ship never listed.
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

  return (
    <div className="radar-scope radar-console periscope-scope">
      <div className="periscope-viewport" role="img" aria-label="Periscope visual contacts">
        <div className="periscope-horizon" />
        <div className="periscope-sea" />
        <div className="periscope-reticule" aria-hidden>
          <span className="periscope-cross periscope-cross--h" />
          <span className="periscope-cross periscope-cross--v" />
          <span className="periscope-bow-mark">BOW</span>
        </div>
        {sorted.length === 0 ? (
          <p className="periscope-empty mono muted">No visual contacts within {maxRangeNm} nm</p>
        ) : (
          <ul className="periscope-silhouettes">
            {sorted.map((c) => {
              const scale = periscopeSilhouetteScale(c.rangeNm, maxRangeNm);
              const url = silhouetteUrlForClass(c.silhouetteClass);
              // Map relative bearing (−180…180) across the viewport (bow center).
              const xPct = 50 + (c.relativeBearing / 90) * 40;
              const clampedX = Math.min(92, Math.max(8, xPct));
              return (
                <li
                  key={c.id}
                  className="periscope-contact"
                  style={{
                    left: `${clampedX}%`,
                    ['--peri-scale' as string]: String(scale),
                  }}
                >
                  {url ? (
                    <img
                      className="periscope-silhouette"
                      src={url}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    <div className="periscope-silhouette periscope-silhouette--missing" title="No silhouette">
                      <span className="mono">?</span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <aside className="radar-side-panel periscope-side-panel">
        <p className="mono muted" style={{ margin: 0, fontSize: '0.8rem' }}>
          VIS · {maxRangeNm} nm · HDG {String(Math.round(ownHeading) % 360).padStart(3, '0')}°
        </p>
        <h3 className="radar-contacts-heading">Contacts</h3>
        {sorted.length === 0 ? (
          <p className="muted mono" style={{ margin: 0, fontSize: '0.85rem' }}>
            Clear
          </p>
        ) : (
          <ol className="radar-contact-list periscope-contact-list">
            {sorted.map((c, i) => (
              <li key={c.id}>
                <span className="mono readout">C{i + 1}</span>
                <span className="mono">{formatRelBearing(c.relativeBearing)}</span>
                <span className="mono muted">~{c.rangeNm.toFixed(1)} nm</span>
                <span className="mono muted">~{c.speedKn} kn</span>
              </li>
            ))}
          </ol>
        )}
        <p className="periscope-caption muted">
          Silhouette only — class image when available. Range scales size (farther = smaller).
        </p>
      </aside>
    </div>
  );
}

export const PeriscopeScope = memo(PeriscopeScopeInner);
