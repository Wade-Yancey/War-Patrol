import { memo, useMemo } from 'react';
import { normalizeHeading } from '@war-patrol/shared';

interface Props {
  /**
   * Selected contact relative bearing degrees (−180, 180].
   * Bow = 0, starboard positive, port negative. `null` → idle (HDG only).
   */
  relativeBearing: number | null;
  /** Own-ship true heading (0–360) — solid HDG needle on the north-up rose. */
  ownHeading: number;
}

/** Match HelmCompass rose geometry so the dial reads the same way. */
const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 118;

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY + Math.sin(rad) * r };
}

/** Match PeriscopeScope / lookout contact readout language. */
export function formatRelBearing(rel: number): string {
  if (rel === 0) return '000° rel';
  const abs = Math.abs(rel);
  const side = rel > 0 ? 'stbd' : 'port';
  return `${String(abs).padStart(3, '0')}° ${side}`;
}

/**
 * CRT optics bearing dial for lookout / periscope.
 *
 * Same visual language as HelmCompass: north-up rose (N/E/S/W), solid HDG
 * needle for own-ship facing, dashed rim-chevron bug for the selected contact
 * (true bearing = heading + relative). Digital REL keeps the contact-list
 * port/stbd wording.
 */
function OpticsBearingCompassInner({ relativeBearing, ownHeading }: Props) {
  const hasContact = relativeBearing !== null && Number.isFinite(relativeBearing);
  const hdg = normalizeHeading(ownHeading);
  const rel = hasContact ? relativeBearing : 0;
  const contactTrue = hasContact ? normalizeHeading(hdg + rel) : null;

  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const relLabel = hasContact ? formatRelBearing(rel) : '——';
  const contactTrueLabel =
    contactTrue !== null ? String(Math.round(contactTrue)).padStart(3, '0') : null;

  const ticks = useMemo(() => {
    const marks: Array<{
      deg: number;
      major: boolean;
      cardinal: string | null;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tx: number;
      ty: number;
    }> = [];
    const cardinals: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let deg = 0; deg < 360; deg += 10) {
      const major = deg % 30 === 0;
      const tick = major ? 14 : 8;
      const outer = polar(deg, R);
      const inner = polar(deg, R - tick);
      const label = polar(deg, R - 28);
      marks.push({
        deg,
        major,
        cardinal: cardinals[deg] ?? null,
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
        tx: label.x,
        ty: label.y,
      });
    }
    return marks;
  }, []);

  const aria = hasContact
    ? `Heading ${hdgLabel} degrees; contact relative bearing ${relLabel}`
    : `Heading ${hdgLabel} degrees; no contact selected`;

  return (
    <div
      className={`optics-bearing-compass${hasContact ? '' : ' optics-bearing-compass--empty'}`}
      role="img"
      aria-label={aria}
    >
      <svg
        className="optics-bearing-compass-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <circle
          cx={CX}
          cy={CY}
          r={R + 28}
          fill="#0a120c"
          stroke="#2a3830"
          strokeWidth={8}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="#041208"
          stroke={hasContact ? '#1a8f3c' : 'rgba(26,143,60,0.45)'}
          strokeWidth={2}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R - 48}
          fill="none"
          stroke="rgba(61,255,106,0.12)"
          strokeWidth={1}
        />

        {ticks.map((t) => (
          <g key={t.deg}>
            <line
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={
                t.major
                  ? hasContact
                    ? '#3dff6a'
                    : 'rgba(61,255,106,0.45)'
                  : hasContact
                    ? 'rgba(61,255,106,0.4)'
                    : 'rgba(61,255,106,0.22)'
              }
              strokeWidth={t.major ? 2 : 1}
            />
            {t.cardinal && (
              <text
                x={t.tx}
                y={t.ty}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={hasContact ? '#7dff9a' : 'rgba(125,255,154,0.5)'}
                fontSize={18}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                fontWeight={700}
              >
                {t.cardinal}
              </text>
            )}
            {t.major && !t.cardinal && (
              <text
                x={t.tx}
                y={t.ty}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={hasContact ? '#5a9a68' : 'rgba(90,154,104,0.45)'}
                fontSize={11}
                fontFamily="IBM Plex Mono, monospace"
              >
                {String(t.deg).padStart(3, '0')}
              </text>
            )}
          </g>
        ))}

        {/* Contact — dashed needle + rim chevron (helm CRS language). */}
        {hasContact && contactTrue !== null && (
          <g
            className="optics-bearing-compass-needle"
            style={{
              transform: `rotate(${contactTrue}deg)`,
              transformOrigin: `${CX}px ${CY}px`,
            }}
          >
            <line
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY - (R - 36)}
              stroke="#3dff6a"
              strokeWidth={2}
              strokeDasharray="5 4"
              opacity={0.85}
            />
            <line
              x1={CX}
              y1={CY - (R - 36)}
              x2={CX}
              y2={CY - (R + 4)}
              stroke="#3dff6a"
              strokeWidth={2.5}
              opacity={0.9}
            />
            <polygon
              points={`${CX},${CY - (R + 16)} ${CX - 9},${CY - (R + 2)} ${CX + 9},${CY - (R + 2)}`}
              fill="#3dff6a"
              opacity={0.95}
            />
          </g>
        )}

        {/* Own heading / bow facing — solid bright pointer (helm HDG language). */}
        <g
          className="optics-bearing-compass-needle"
          style={{ transform: `rotate(${hdg}deg)`, transformOrigin: `${CX}px ${CY}px` }}
        >
          <polygon
            points={`${CX},${CY - (R - 22)} ${CX - 7},${CY + 22} ${CX + 7},${CY + 22}`}
            fill={hasContact ? '#7dff9a' : 'rgba(125,255,154,0.55)'}
            stroke={hasContact ? '#b8ffc8' : 'rgba(184,255,200,0.45)'}
            strokeWidth={1}
          />
        </g>

        <circle cx={CX} cy={CY} r={6} fill="#041208" stroke="#3dff6a" strokeWidth={2} />
        <circle
          cx={CX}
          cy={CY}
          r={2.5}
          fill={hasContact ? '#3dff6a' : 'rgba(61,255,106,0.4)'}
        />
      </svg>

      <div className="optics-bearing-compass-readouts">
        <div className="optics-bearing-compass-readout">
          <span className="optics-bearing-compass-key">HDG</span>
          <span className="readout optics-bearing-compass-val">{hdgLabel}°</span>
        </div>
        <div className="optics-bearing-compass-readout">
          <span className="optics-bearing-compass-key">REL</span>
          <span className={`readout optics-bearing-compass-val${hasContact ? '' : ' muted'}`}>
            {relLabel}
          </span>
        </div>
      </div>

      <div className="optics-bearing-compass-legend" aria-hidden>
        <span>
          <i className="optics-bearing-compass-swatch optics-bearing-compass-swatch--hdg" /> Bow
          (HDG)
        </span>
        <span>
          <i className="optics-bearing-compass-swatch optics-bearing-compass-swatch--contact" />{' '}
          Contact
          {contactTrueLabel ? ` ${contactTrueLabel}°` : ''}
        </span>
      </div>

      <p className="optics-bearing-compass-caption muted mono">
        North-up like helm · REL is contact angle from bow
      </p>
    </div>
  );
}

export const OpticsBearingCompass = memo(OpticsBearingCompassInner);
