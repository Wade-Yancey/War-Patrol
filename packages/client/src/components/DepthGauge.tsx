import { memo, useMemo } from 'react';
import {
  DIVE_BAND_MARKS,
  FLEET_SUB_CRUSH_DEPTH_M,
  FLEET_SUB_TEST_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_MAX_DEPTH_M,
  formatCoarseDepthMeters,
  submarineDepthRisk,
} from '@war-patrol/shared';
import { useTweenedDepth } from '../hooks/useTweenedDepth';

/** Same viewBox footprint as helm / radar CRT dials. */
export const DEPTH_GAUGE_SIZE = 320;
export const DEPTH_GAUGE_CX = DEPTH_GAUGE_SIZE / 2;
export const DEPTH_GAUGE_CY = DEPTH_GAUGE_SIZE / 2;
export const DEPTH_GAUGE_R = 118;

/**
 * Classic analog sweep: surface at −135° (7:30), deeper clockwise to +135°
 * (4:30). Degrees are compass-style — 0 at 12 o'clock, clockwise positive.
 */
export const DEPTH_GAUGE_START_DEG = -135;
export const DEPTH_GAUGE_SWEEP_DEG = 270;

/** Major meter marks on the dial face (plus 0 / max). */
const MAJOR_DEPTH_MARKS_M = [0, 30, 60, 90, 120, 150, 180] as const;

export interface DepthGaugeProps {
  /** Actual keel depth (m) — needle + DEPTH readout tween toward this. */
  depth: number;
  /** Standing ordered depth set-point (m) — live bug, not tweened. */
  orderedDepth: number;
  /** Draft depth on the control (pre-submit) — faint SET bug when ≠ ordered. */
  draftDepth?: number;
  maxDepthM?: number;
}

/** Map keel depth (m) → needle angle (deg from 12 o'clock, clockwise). */
export function depthToNeedleAngle(
  depthM: number,
  maxDepthM: number = SUBMARINE_MAX_DEPTH_M,
): number {
  const max = Math.max(1, maxDepthM);
  const t = Math.min(1, Math.max(0, depthM / max));
  return DEPTH_GAUGE_START_DEG + t * DEPTH_GAUGE_SWEEP_DEG;
}

function polar(deg: number, r: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return {
    x: DEPTH_GAUGE_CX + Math.cos(rad) * r,
    y: DEPTH_GAUGE_CY + Math.sin(rad) * r,
  };
}

function describeArc(startDeg: number, endDeg: number, r: number): string {
  const start = polar(startDeg, r);
  const end = polar(endDeg, r);
  const sweep = endDeg - startDeg;
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const sweepFlag = sweep >= 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} ${sweepFlag} ${end.x} ${end.y}`;
}

/**
 * WWII U-boat–inspired CRT depth gauge for Dive Plane.
 * Keel DEPTH needle + digital readout tween via {@link useTweenedDepth}
 * (same CONTACT_TWEEN_MS window as helm HDG); ORDERED / SET bugs stay live.
 */
function DepthGaugeInner({
  depth,
  orderedDepth,
  draftDepth,
  maxDepthM = SUBMARINE_MAX_DEPTH_M,
}: DepthGaugeProps) {
  const displayDepth = useTweenedDepth(depth);
  const depthAngle = depthToNeedleAngle(displayDepth, maxDepthM);
  const orderedAngle = depthToNeedleAngle(orderedDepth, maxDepthM);
  const showDraft =
    draftDepth !== undefined &&
    Math.abs(Math.round(draftDepth) - Math.round(orderedDepth)) >= 1;
  const draftAngle =
    showDraft && draftDepth !== undefined
      ? depthToNeedleAngle(draftDepth, maxDepthM)
      : null;

  const depthLabel = formatCoarseDepthMeters(displayDepth);
  const orderedLabel = formatCoarseDepthMeters(orderedDepth);
  const draftLabel =
    showDraft && draftDepth !== undefined
      ? formatCoarseDepthMeters(draftDepth)
      : null;

  const step = SUBMARINE_DEPTH_ORDER_STEP_M;
  const coarseDepth = Math.round(displayDepth / step) * step;
  const coarseOrdered = Math.round(orderedDepth / step) * step;
  const onOrdered = coarseDepth === coarseOrdered;
  const keelRisk = submarineDepthRisk(displayDepth);

  const ticks = useMemo(() => {
    const marks: {
      depthM: number;
      major: boolean;
      band: 'patrol' | 'test' | 'crush' | null;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      tx: number;
      ty: number;
      label: string;
    }[] = [];

    const bandByDepth = new Map<number, 'patrol' | 'test' | 'crush'>(
      DIVE_BAND_MARKS.map((m) => [m.depthM, m.id]),
    );

    for (let d = 0; d <= maxDepthM; d += 10) {
      const major =
        (MAJOR_DEPTH_MARKS_M as readonly number[]).includes(d) ||
        bandByDepth.has(d) ||
        d === maxDepthM;
      const ang = depthToNeedleAngle(d, maxDepthM);
      const outer = polar(ang, DEPTH_GAUGE_R);
      const inner = polar(ang, DEPTH_GAUGE_R - (major ? 14 : 8));
      const labelPt = polar(ang, DEPTH_GAUGE_R - 30);
      marks.push({
        depthM: d,
        major,
        band: bandByDepth.get(d) ?? null,
        x1: inner.x,
        y1: inner.y,
        x2: outer.x,
        y2: outer.y,
        tx: labelPt.x,
        ty: labelPt.y,
        label: String(d),
      });
    }
    return marks;
  }, [maxDepthM]);

  const safeEnd = depthToNeedleAngle(FLEET_SUB_TEST_DEPTH_M, maxDepthM);
  const crushStart = depthToNeedleAngle(FLEET_SUB_CRUSH_DEPTH_M, maxDepthM);
  const maxAng = depthToNeedleAngle(maxDepthM, maxDepthM);
  const startAng = DEPTH_GAUGE_START_DEG;

  const needleTip = polar(depthAngle, DEPTH_GAUGE_R - 18);
  const needleTail = polar(depthAngle + 180, 22);
  const orderedTip = polar(orderedAngle, DEPTH_GAUGE_R + 10);
  const orderedInner = polar(orderedAngle, DEPTH_GAUGE_R - 4);

  return (
    <div className="radar-scope radar-console crt-console depth-gauge">
      <div className="radar-scope-plot">
        <svg
          className="radar-scope-svg depth-gauge-svg"
          viewBox={`0 0 ${DEPTH_GAUGE_SIZE} ${DEPTH_GAUGE_SIZE}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`Depth gauge: keel ${depthLabel}, ordered ${orderedLabel}${
            draftLabel ? `, set ${draftLabel}` : ''
          }.`}
        >
          {/* Bezel */}
          <circle
            cx={DEPTH_GAUGE_CX}
            cy={DEPTH_GAUGE_CY}
            r={DEPTH_GAUGE_R + 28}
            fill="#0a120c"
            stroke="#2a3830"
            strokeWidth={8}
          />
          <circle
            cx={DEPTH_GAUGE_CX}
            cy={DEPTH_GAUGE_CY}
            r={DEPTH_GAUGE_R}
            fill="#041208"
            stroke="#1a8f3c"
            strokeWidth={2}
          />

          {/* Risk arc bands under the ticks */}
          <path
            d={describeArc(startAng, safeEnd, DEPTH_GAUGE_R - 4)}
            fill="none"
            stroke="rgba(61,255,106,0.22)"
            strokeWidth={6}
            strokeLinecap="butt"
          />
          <path
            d={describeArc(safeEnd, crushStart, DEPTH_GAUGE_R - 4)}
            fill="none"
            stroke="rgba(196,163,90,0.45)"
            strokeWidth={6}
            strokeLinecap="butt"
          />
          <path
            d={describeArc(crushStart, maxAng, DEPTH_GAUGE_R - 4)}
            fill="none"
            stroke="rgba(196,90,90,0.55)"
            strokeWidth={6}
            strokeLinecap="butt"
          />

          {/* Tick marks + labels */}
          {ticks.map((t) => {
            const stroke = t.band
              ? t.band === 'crush'
                ? '#c45a5a'
                : t.band === 'test'
                  ? '#c4a35a'
                  : '#3dff6a'
              : t.major
                ? '#3dff6a'
                : 'rgba(61,255,106,0.4)';
            return (
              <g key={t.depthM}>
                <line
                  x1={t.x1}
                  y1={t.y1}
                  x2={t.x2}
                  y2={t.y2}
                  stroke={stroke}
                  strokeWidth={t.major ? 2 : 1}
                />
                {t.major && (
                  <text
                    x={t.tx}
                    y={t.ty}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="depth-gauge-tick-label"
                    fill={stroke}
                  >
                    {t.label}
                  </text>
                )}
              </g>
            );
          })}

          {/* Title plate */}
          <text
            x={DEPTH_GAUGE_CX}
            y={DEPTH_GAUGE_CY - 36}
            textAnchor="middle"
            className="depth-gauge-face-title"
            fill="rgba(125,255,154,0.55)"
          >
            TIEFENMESSER
          </text>
          <text
            x={DEPTH_GAUGE_CX}
            y={DEPTH_GAUGE_CY - 20}
            textAnchor="middle"
            className="depth-gauge-face-unit"
            fill="rgba(90,154,104,0.7)"
          >
            METERS
          </text>

          {/* Ordered bug — live, dashed */}
          <g className="depth-gauge-bug depth-gauge-bug--ordered" aria-hidden>
            <line
              x1={orderedInner.x}
              y1={orderedInner.y}
              x2={orderedTip.x}
              y2={orderedTip.y}
              stroke="#7dff9a"
              strokeWidth={2}
              strokeDasharray="4 3"
              opacity={0.85}
            />
            <polygon
              points={`${orderedTip.x},${orderedTip.y} ${
                polar(orderedAngle - 8, DEPTH_GAUGE_R + 18).x
              },${polar(orderedAngle - 8, DEPTH_GAUGE_R + 18).y} ${
                polar(orderedAngle + 8, DEPTH_GAUGE_R + 18).x
              },${polar(orderedAngle + 8, DEPTH_GAUGE_R + 18).y}`}
              fill="#7dff9a"
              opacity={0.75}
            />
          </g>

          {/* Draft SET bug */}
          {draftAngle !== null && (
            <g className="depth-gauge-bug depth-gauge-bug--set" opacity={0.55}>
              <circle
                cx={polar(draftAngle, DEPTH_GAUGE_R + 16).x}
                cy={polar(draftAngle, DEPTH_GAUGE_R + 16).y}
                r={5}
                fill="none"
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
              <line
                x1={polar(draftAngle, DEPTH_GAUGE_R - 6).x}
                y1={polar(draftAngle, DEPTH_GAUGE_R - 6).y}
                x2={polar(draftAngle, DEPTH_GAUGE_R + 8).x}
                y2={polar(draftAngle, DEPTH_GAUGE_R + 8).y}
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
            </g>
          )}

          {/* Keel depth needle — tweened */}
          <g className="depth-gauge-needle">
            <line
              x1={needleTail.x}
              y1={needleTail.y}
              x2={needleTip.x}
              y2={needleTip.y}
              stroke={
                keelRisk === 'past_crush' || keelRisk === 'at_crush'
                  ? '#ff8a6a'
                  : keelRisk === 'below_test'
                    ? '#d4b56a'
                    : '#e8ffe8'
              }
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            <circle
              cx={DEPTH_GAUGE_CX}
              cy={DEPTH_GAUGE_CY}
              r={8}
              fill="#0a120c"
              stroke="#3dff6a"
              strokeWidth={2}
            />
            <circle cx={DEPTH_GAUGE_CX} cy={DEPTH_GAUGE_CY} r={3} fill="#7dff9a" />
          </g>
        </svg>
      </div>

      <div className="radar-side-panel depth-gauge-aux">
        <div className="crt-console-readouts depth-gauge-readouts" aria-live="polite">
          <div className="crt-console-readout depth-gauge-readout">
            <span className="crt-console-key depth-gauge-key">DEPTH</span>
            <span className="readout crt-console-val depth-gauge-val">{depthLabel}</span>
          </div>
          <div className="crt-console-readout depth-gauge-readout">
            <span className="crt-console-key depth-gauge-key">ORDERED</span>
            <span className="readout crt-console-val depth-gauge-val">{orderedLabel}</span>
            {onOrdered && <span className="depth-gauge-ok">ON</span>}
          </div>
          {draftLabel && (
            <div className="crt-console-readout depth-gauge-readout depth-gauge-readout--draft">
              <span className="crt-console-key depth-gauge-key">SET</span>
              <span className="readout crt-console-val depth-gauge-val">{draftLabel}</span>
            </div>
          )}
        </div>

        <div className="depth-gauge-legend" aria-hidden>
          <span>
            <i className="depth-gauge-swatch depth-gauge-swatch--keel" /> Keel
          </span>
          <span>
            <i className="depth-gauge-swatch depth-gauge-swatch--ord" /> Ordered
          </span>
          {draftLabel && (
            <span>
              <i className="depth-gauge-swatch depth-gauge-swatch--set" /> Set
            </span>
          )}
        </div>

        <p className="crt-console-caption depth-gauge-caption muted mono">
          Surface 0 · test {FLEET_SUB_TEST_DEPTH_M} · crush {FLEET_SUB_CRUSH_DEPTH_M} ·
          max {maxDepthM} m
        </p>
      </div>
    </div>
  );
}

export const DepthGauge = memo(DepthGaugeInner);
