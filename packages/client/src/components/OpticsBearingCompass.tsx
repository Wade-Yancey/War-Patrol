import { memo, useMemo } from 'react';

interface Props {
  /**
   * Selected contact relative bearing degrees (−180, 180].
   * Bow = 0, starboard positive, port negative. `null` → empty/neutral rose.
   */
  relativeBearing: number | null;
}

const SIZE = 200;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 72;

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
 * Compact CRT relative-bearing compass for lookout / periscope optics.
 * Bow-up rose; contact bug at selected relative bearing. Neutral when none selected.
 */
function OpticsBearingCompassInner({ relativeBearing }: Props) {
  const hasContact = relativeBearing !== null && Number.isFinite(relativeBearing);
  const rel = hasContact ? relativeBearing : 0;
  const brgLabel = hasContact ? formatRelBearing(rel) : '——';

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
    const labels: Record<number, string> = {
      0: 'BOW',
      90: 'STBD',
      180: 'ASTN',
      270: 'PORT',
    };
    for (let deg = 0; deg < 360; deg += 15) {
      const major = deg % 90 === 0;
      const mid = deg % 45 === 0;
      const tick = major ? 12 : mid ? 8 : 5;
      const outer = polar(deg, R);
      const inner = polar(deg, R - tick);
      const labelPt = polar(deg, R - 24);
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
    ? `Contact relative bearing ${brgLabel}`
    : 'No contact selected — relative bearing compass idle';

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
          r={R + 18}
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
          r={R - 36}
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
                fontSize={11}
                fontFamily="Share Tech Mono, IBM Plex Mono, monospace"
                fontWeight={700}
              >
                {t.label}
              </text>
            )}
          </g>
        ))}

        {/* Fixed bow lubber — own-ship reference (always visible). */}
        <line
          x1={CX}
          y1={CY - (R - 34)}
          x2={CX}
          y2={CY - (R - 6)}
          stroke={hasContact ? 'rgba(125,255,154,0.55)' : 'rgba(125,255,154,0.28)'}
          strokeWidth={2}
        />
        <polygon
          points={`${CX},${CY - (R + 10)} ${CX - 6},${CY - (R - 2)} ${CX + 6},${CY - (R - 2)}`}
          fill={hasContact ? 'rgba(125,255,154,0.7)' : 'rgba(125,255,154,0.3)'}
        />

        {/* Contact relative-bearing bug — hidden when idle. */}
        {hasContact && (
          <g
            className="optics-bearing-compass-needle"
            style={{ transform: `rotate(${rel}deg)`, transformOrigin: `${CX}px ${CY}px` }}
          >
            <line
              x1={CX}
              y1={CY + 14}
              x2={CX}
              y2={CY - (R - 14)}
              stroke="#3dff6a"
              strokeWidth={2.5}
            />
            <polygon
              points={`${CX},${CY - (R + 6)} ${CX - 8},${CY - (R - 10)} ${CX + 8},${CY - (R - 10)}`}
              fill="#7dff9a"
              stroke="#b8ffc8"
              strokeWidth={1}
            />
          </g>
        )}

        <circle cx={CX} cy={CY} r={5} fill="#041208" stroke="#3dff6a" strokeWidth={1.5} />
        <circle
          cx={CX}
          cy={CY}
          r={2}
          fill={hasContact ? '#3dff6a' : 'rgba(61,255,106,0.35)'}
        />
      </svg>

      <div className="optics-bearing-compass-readout mono">
        <span className="optics-bearing-compass-key">BRG</span>
        <span className={`readout optics-bearing-compass-val${hasContact ? '' : ' muted'}`}>
          {brgLabel}
        </span>
      </div>
    </div>
  );
}

export const OpticsBearingCompass = memo(OpticsBearingCompassInner);
