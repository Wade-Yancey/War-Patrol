import { memo, useMemo } from 'react';
import { normalizeHeading } from '@war-patrol/shared';

interface Props {
  /** Live bow heading, degrees true. */
  heading: number;
  /** Standing ordered / steering course, degrees true. */
  orderedCourse: number;
  /**
   * Draft course on the helm control (pre-submit). Shown as a faint SET mark
   * only when it differs from the ordered course.
   */
  draftCourse?: number;
  /** Optional turn rate caption (°/min). */
  turnRate?: number;
}

const SIZE = 320;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 118;

function shortestDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY + Math.sin(rad) * r };
}

/**
 * CRT gyro-style compass for the helmsman: north-up rose with distinct
 * heading needle and ordered-course bug. Live unit state only — no fake data.
 */
function HelmCompassInner({ heading, orderedCourse, draftCourse, turnRate }: Props) {
  const hdg = normalizeHeading(heading);
  const crs = normalizeHeading(orderedCourse);
  const draft =
    draftCourse === undefined ? undefined : normalizeHeading(draftCourse);

  const showDraft =
    draft !== undefined && Math.abs(shortestDelta(crs, draft)) > 0.5;
  const onCourse = Math.abs(shortestDelta(hdg, crs)) < 0.75;

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

  const hdgLabel = String(Math.round(hdg)).padStart(3, '0');
  const crsLabel = String(Math.round(crs)).padStart(3, '0');
  const draftLabel =
    showDraft && draft !== undefined
      ? String(Math.round(draft)).padStart(3, '0')
      : null;

  return (
    <div
      className="helm-compass"
      role="img"
      aria-label={`Compass: heading ${hdgLabel} degrees, ordered course ${crsLabel} degrees${
        draftLabel ? `, set ${draftLabel} degrees` : ''
      }`}
    >
      <svg
        className="helm-compass-svg"
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
        <circle cx={CX} cy={CY} r={R} fill="#041208" stroke="#1a8f3c" strokeWidth={2} />
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
              stroke={t.major ? '#3dff6a' : 'rgba(61,255,106,0.4)'}
              strokeWidth={t.major ? 2 : 1}
            />
            {t.cardinal && (
              <text
                x={t.tx}
                y={t.ty}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#7dff9a"
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
                fill="#5a9a68"
                fontSize={11}
                fontFamily="IBM Plex Mono, monospace"
              >
                {String(t.deg).padStart(3, '0')}
              </text>
            )}
          </g>
        ))}

        {/* Ordered course — dashed needle + rim chevron (rotates with CRS). */}
        <g
          className="helm-compass-needle"
          style={{ transform: `rotate(${crs}deg)`, transformOrigin: `${CX}px ${CY}px` }}
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

        {/* Draft SET mark (pre-submit), only when it differs from CRS. */}
        {showDraft && draft !== undefined && (
          <g
            className="helm-compass-needle helm-compass-draft"
            style={{ transform: `rotate(${draft}deg)`, transformOrigin: `${CX}px ${CY}px` }}
            opacity={0.55}
          >
            <circle cx={CX} cy={CY - (R + 16)} r={5} fill="none" stroke="#7dff9a" strokeWidth={1.5} />
            <line
              x1={CX}
              y1={CY - (R - 6)}
              x2={CX}
              y2={CY - (R + 8)}
              stroke="#7dff9a"
              strokeWidth={1.5}
            />
          </g>
        )}

        {/* Heading — solid bright pointer. */}
        <g
          className="helm-compass-needle"
          style={{ transform: `rotate(${hdg}deg)`, transformOrigin: `${CX}px ${CY}px` }}
        >
          <polygon
            points={`${CX},${CY - (R - 22)} ${CX - 7},${CY + 22} ${CX + 7},${CY + 22}`}
            fill="#7dff9a"
            stroke="#b8ffc8"
            strokeWidth={1}
          />
        </g>

        <circle cx={CX} cy={CY} r={6} fill="#041208" stroke="#3dff6a" strokeWidth={2} />
        <circle cx={CX} cy={CY} r={2.5} fill="#3dff6a" />
      </svg>

      <div className="helm-compass-readouts">
        <div className="helm-compass-readout">
          <span className="helm-compass-key">HDG</span>
          <span className="readout helm-compass-val">{hdgLabel}°</span>
        </div>
        <div className="helm-compass-readout">
          <span className="helm-compass-key">CRS</span>
          <span className="readout helm-compass-val">{crsLabel}°</span>
          {onCourse && <span className="helm-compass-ok">ON</span>}
        </div>
        {draftLabel && (
          <div className="helm-compass-readout helm-compass-readout--draft">
            <span className="helm-compass-key">SET</span>
            <span className="readout helm-compass-val">{draftLabel}°</span>
          </div>
        )}
      </div>

      <div className="helm-compass-legend" aria-hidden>
        <span>
          <i className="helm-compass-swatch helm-compass-swatch--hdg" /> Heading
        </span>
        <span>
          <i className="helm-compass-swatch helm-compass-swatch--crs" /> Ordered
        </span>
        {draftLabel && (
          <span>
            <i className="helm-compass-swatch helm-compass-swatch--set" /> Set
          </span>
        )}
      </div>

      {turnRate !== undefined && (
        <p className="helm-compass-caption muted mono">
          Turn rate {turnRate.toFixed(0)}°/min · ship yaws toward CRS each resolve
        </p>
      )}
    </div>
  );
}

export const HelmCompass = memo(HelmCompassInner);
