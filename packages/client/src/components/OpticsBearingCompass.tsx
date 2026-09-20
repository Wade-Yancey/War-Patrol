import { memo, useMemo } from 'react';

interface Props {
  /**
   * Selected contact relative bearing degrees (−180, 180].
   * Bow = 0, starboard positive, port negative. `null` → empty/neutral rose.
   * This is ship-relative only — not a true/magnetic bearing.
   */
  relativeBearing: number | null;
  /**
   * Own-ship true heading (0–360) — facing reference only.
   * Shown as a separate HDG readout; does not rotate the dial (bow stays up).
   */
  ownHeading: number;
}

const SIZE = 240;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 86;

function polar(deg: number, r: number): { x: number; y: number } {
  // SVG: 0° relative = bow = top of dial (ship-frame, not north-up).
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

function formatHeading(hdg: number): string {
  const n = ((Math.round(hdg) % 360) + 360) % 360;
  return `${String(n).padStart(3, '0')}°`;
}

/**
 * CRT relative-bearing dial for lookout / periscope.
 *
 * Ship-frame only: bow is fixed at the top (lubber). The contact bug sits at the
 * selected contact's relative bearing — same numbers as the contact list
 * (`000° rel` / port–stbd). Own heading is a separate facing readout and never
 * rotates this rose (avoids mixing true/absolute compass with relative bearing).
 */
function OpticsBearingCompassInner({ relativeBearing, ownHeading }: Props) {
  const hasContact = relativeBearing !== null && Number.isFinite(relativeBearing);
  const rel = hasContact ? relativeBearing : 0;
  const brgLabel = hasContact ? formatRelBearing(rel) : '——';
  const hdgLabel = formatHeading(ownHeading);

  const ticks = useMemo(() => {
    const marks: Array<{
      deg: number;
      major: boolean;
      label: string | null;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tx: number;
      ty: number;
    }> = [];
    // Relative-degree labels (ship frame) — not N/E/S/W absolute.
    const labels: Record<number, string> = {
      0: '0°',
      90: '90°',
      180: '180°',
      270: '90°',
    };
    for (let deg = 0; deg < 360; deg += 15) {
      const major = deg % 90 === 0;
      const mid = deg % 45 === 0;
      const tick = major ? 14 : mid ? 9 : 5;
      const outer = polar(deg, R);
      const inner = polar(deg, R - tick);
      const labelPt = polar(deg, R - 26);
      marks.push({
        deg,
        major,
        label: labels[deg] ?? null,
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
        tx: labelPt.x,
        ty: labelPt.y,
      });
    }
    return marks;
  }, []);

  const aria = hasContact
    ? `Relative bearing ${brgLabel}; own ship heading ${hdgLabel}`
    : `Relative bearing idle; own ship heading ${hdgLabel}`;

  return (
    <div
      className={`optics-bearing-compass${hasContact ? '' : ' optics-bearing-compass--empty'}`}
      role="img"
      aria-label={aria}
    >
      <p className="optics-bearing-compass-title mono muted">REL BEARING · BOW UP</p>

      <svg
        className="optics-bearing-compass-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <circle
          cx={CX}
          cy={CY}
          r={R + 20}
          fill="#0a120c"
          stroke="#2a3830"
          strokeWidth={6}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="#041208"
          stroke={hasContact ? '#1a8f3c' : 'rgba(26,143,60,0.35)'}
          strokeWidth={2}
        />
        <circle
          cx={CX}
          cy={CY}
          r={R - 40}
          fill="none"
          stroke="rgba(61,255,106,0.1)"
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
                    : 'rgba(61,255,106,0.35)'
                  : hasContact
                    ? 'rgba(61,255,106,0.4)'
                    : 'rgba(61,255,106,0.18)'
              }
              strokeWidth={t.major ? 2 : 1}
            />
            {t.label && (
              <text
                x={t.tx}
                y={t.ty}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={hasContact ? '#7dff9a' : 'rgba(125,255,154,0.4)'}
                fontSize={12}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                fontWeight={700}
              >
                {t.label}
              </text>
            )}
          </g>
        ))}

        {/* Side cues — ship frame, not absolute cardinals. */}
        <text
          x={polar(90, R - 52).x}
          y={polar(90, R - 52).y}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={hasContact ? 'rgba(125,255,154,0.75)' : 'rgba(125,255,154,0.35)'}
          fontSize={10}
          fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
          fontWeight={700}
        >
          STBD
        </text>
        <text
          x={polar(270, R - 52).x}
          y={polar(270, R - 52).y}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={hasContact ? 'rgba(125,255,154,0.75)' : 'rgba(125,255,154,0.35)'}
          fontSize={10}
          fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
          fontWeight={700}
        >
          PORT
        </text>

        {/* Fixed bow lubber — own-ship facing on this dial (always top). */}
        <g className="optics-bearing-compass-lubber">
          <line
            x1={CX}
            y1={CY - (R - 38)}
            x2={CX}
            y2={CY - (R - 6)}
            stroke={hasContact ? 'rgba(125,255,154,0.55)' : 'rgba(125,255,154,0.28)'}
            strokeWidth={2}
          />
          <polygon
            points={`${CX},${CY - (R + 12)} ${CX - 7},${CY - (R - 2)} ${CX + 7},${CY - (R - 2)}`}
            fill={hasContact ? 'rgba(125,255,154,0.85)' : 'rgba(125,255,154,0.4)'}
          />
          <text
            x={CX}
            y={CY - (R + 22)}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={hasContact ? '#b8ffc8' : 'rgba(184,255,200,0.45)'}
            fontSize={10}
            fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
            fontWeight={700}
            letterSpacing="0.08em"
          >
            BOW
          </text>
        </g>

        {/* Contact relative-bearing bug — angle from bow on this dial. */}
        {hasContact && (
          <g
            className="optics-bearing-compass-needle"
            style={{ transform: `rotate(${rel}deg)`, transformOrigin: `${CX}px ${CY}px` }}
          >
            <line
              x1={CX}
              y1={CY + 16}
              x2={CX}
              y2={CY - (R - 16)}
              stroke="#3dff6a"
              strokeWidth={2.75}
            />
            <polygon
              points={`${CX},${CY - (R + 4)} ${CX - 9},${CY - (R - 12)} ${CX + 9},${CY - (R - 12)}`}
              fill="#7dff9a"
              stroke="#b8ffc8"
              strokeWidth={1}
            />
          </g>
        )}

        <circle cx={CX} cy={CY} r={5.5} fill="#041208" stroke="#3dff6a" strokeWidth={1.5} />
        <circle
          cx={CX}
          cy={CY}
          r={2.25}
          fill={hasContact ? '#3dff6a' : 'rgba(61,255,106,0.35)'}
        />
      </svg>

      <div className="optics-bearing-compass-readouts">
        <div className="optics-bearing-compass-readout mono">
          <span className="optics-bearing-compass-key">OWN</span>
          <span className="readout optics-bearing-compass-val">{hdgLabel}</span>
        </div>
        <div className="optics-bearing-compass-readout mono">
          <span className="optics-bearing-compass-key">REL</span>
          <span className={`readout optics-bearing-compass-val${hasContact ? '' : ' muted'}`}>
            {brgLabel}
          </span>
        </div>
      </div>

      <p className="optics-bearing-compass-caption muted mono">
        Contact angle from bow · dial does not rotate with heading
      </p>
    </div>
  );
}

export const OpticsBearingCompass = memo(OpticsBearingCompassInner);
