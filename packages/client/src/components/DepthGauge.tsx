import { memo, useMemo, type ReactNode } from 'react';
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

/** Compact CRT dial footprint (smaller than helm / radar so dive fits one view). */
export const DEPTH_GAUGE_SIZE = 280;
export const DEPTH_GAUGE_CX = DEPTH_GAUGE_SIZE / 2;
export const DEPTH_GAUGE_CY = DEPTH_GAUGE_SIZE / 2;
export const DEPTH_GAUGE_R = 102;

/**
 * Classic analog sweep: surface at −135° (7:30), deeper clockwise to +135°
 * (4:30). Degrees are compass-style — 0 at 12 o'clock, clockwise positive.
 * Linear in meters: angle = START + (depth / max) * SWEEP.
 */
export const DEPTH_GAUGE_START_DEG = -135;
export const DEPTH_GAUGE_SWEEP_DEG = 270;

/**
 * Labeled major marks — uniform 30 m steps across 0…180 so spacing stays even
 * on the 270° sweep (45° per major). Band depths (50 / 90 / 150) use colored
 * ticks; 90 and 150 already land on majors.
 */
const LABELED_DEPTH_MARKS_M = [0, 30, 60, 90, 120, 150, 180] as const;

/** Minor tick interval (m). */
const MINOR_TICK_M = 10;

export interface DepthGaugeProps {
  /** Actual keel depth (m) — needle + DEPTH readout tween toward this. */
  depth: number;
  /** Standing ordered depth set-point (m) — live bug, not tweened. */
  orderedDepth: number;
  /** Draft depth on the control (pre-submit) — faint SET bug when ≠ ordered. */
  draftDepth?: number;
  maxDepthM?: number;
  /** Side-panel actions (presets / dial / submit) — same aux column as helm. */
  children?: ReactNode;
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

/** Digital keel readout that tracks the needle (nearest meter, not order grid). */
export function formatGaugeDepthMeters(depthM: number): string {
  const n = Math.round(Number.isFinite(depthM) ? depthM : 0);
  const clamped = Math.max(0, n);
  return `${String(clamped).padStart(3, '0')} m`;
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
  children,
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

  const depthLabel = formatGaugeDepthMeters(displayDepth);
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
      kind: 'major' | 'minor' | 'band';
      band: 'patrol' | 'test' | 'crush' | null;
      labeled: boolean;
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
    const labeled = new Set<number>(
      LABELED_DEPTH_MARKS_M.filter((d) => d <= maxDepthM),
    );
    if (!labeled.has(maxDepthM) && maxDepthM % 30 === 0) {
      labeled.add(maxDepthM);
    }

    const depths = new Set<number>();
    for (let d = 0; d <= maxDepthM; d += MINOR_TICK_M) depths.add(d);
    for (const d of bandByDepth.keys()) {
      if (d >= 0 && d <= maxDepthM) depths.add(d);
    }
    depths.add(maxDepthM);

    for (const d of [...depths].sort((a, b) => a - b)) {
      const band = bandByDepth.get(d) ?? null;
      const isLabeled = labeled.has(d);
      const kind: 'major' | 'minor' | 'band' = isLabeled
        ? 'major'
        : band
          ? 'band'
          : 'minor';
      const tickLen = kind === 'major' ? 14 : kind === 'band' ? 11 : 7;
      const ang = depthToNeedleAngle(d, maxDepthM);
      const outer = polar(ang, DEPTH_GAUGE_R);
      const inner = polar(ang, DEPTH_GAUGE_R - tickLen);
      const labelPt = polar(ang, DEPTH_GAUGE_R - 28);
      marks.push({
        depthM: d,
        kind,
        band,
        labeled: isLabeled,
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

  // Tip sits just inside the tick ring so it reads against the scale.
  const needleTip = polar(depthAngle, DEPTH_GAUGE_R - 6);
  const needleTail = polar(depthAngle + 180, 18);
  const orderedTip = polar(orderedAngle, DEPTH_GAUGE_R + 8);
  const orderedInner = polar(orderedAngle, DEPTH_GAUGE_R - 2);

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
          <circle
            cx={DEPTH_GAUGE_CX}
            cy={DEPTH_GAUGE_CY}
            r={DEPTH_GAUGE_R + 22}
            fill="#0a120c"
            stroke="#2a3830"
            strokeWidth={7}
          />
          <circle
            cx={DEPTH_GAUGE_CX}
            cy={DEPTH_GAUGE_CY}
            r={DEPTH_GAUGE_R}
            fill="#041208"
            stroke="#1a8f3c"
            strokeWidth={2}
          />

          <path
            d={describeArc(startAng, safeEnd, DEPTH_GAUGE_R - 3)}
            fill="none"
            stroke="rgba(61,255,106,0.22)"
            strokeWidth={5}
            strokeLinecap="butt"
          />
          <path
            d={describeArc(safeEnd, crushStart, DEPTH_GAUGE_R - 3)}
            fill="none"
            stroke="rgba(196,163,90,0.45)"
            strokeWidth={5}
            strokeLinecap="butt"
          />
          <path
            d={describeArc(crushStart, maxAng, DEPTH_GAUGE_R - 3)}
            fill="none"
            stroke="rgba(196,90,90,0.55)"
            strokeWidth={5}
            strokeLinecap="butt"
          />

          {ticks.map((t) => {
            const stroke = t.band
              ? t.band === 'crush'
                ? '#c45a5a'
                : t.band === 'test'
                  ? '#c4a35a'
                  : '#3dff6a'
              : t.kind === 'major'
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
                  strokeWidth={t.kind === 'major' ? 2 : 1}
                />
                {t.labeled && (
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

          <text
            x={DEPTH_GAUGE_CX}
            y={DEPTH_GAUGE_CY - 28}
            textAnchor="middle"
            className="depth-gauge-face-title"
            fill="rgba(125,255,154,0.55)"
          >
            DEPTH
          </text>
          <text
            x={DEPTH_GAUGE_CX}
            y={DEPTH_GAUGE_CY - 14}
            textAnchor="middle"
            className="depth-gauge-face-unit"
            fill="rgba(90,154,104,0.7)"
          >
            METERS
          </text>

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
                polar(orderedAngle - 8, DEPTH_GAUGE_R + 16).x
              },${polar(orderedAngle - 8, DEPTH_GAUGE_R + 16).y} ${
                polar(orderedAngle + 8, DEPTH_GAUGE_R + 16).x
              },${polar(orderedAngle + 8, DEPTH_GAUGE_R + 16).y}`}
              fill="#7dff9a"
              opacity={0.75}
            />
          </g>

          {draftAngle !== null && (
            <g className="depth-gauge-bug depth-gauge-bug--set" opacity={0.55}>
              <circle
                cx={polar(draftAngle, DEPTH_GAUGE_R + 14).x}
                cy={polar(draftAngle, DEPTH_GAUGE_R + 14).y}
                r={4}
                fill="none"
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
              <line
                x1={polar(draftAngle, DEPTH_GAUGE_R - 4).x}
                y1={polar(draftAngle, DEPTH_GAUGE_R - 4).y}
                x2={polar(draftAngle, DEPTH_GAUGE_R + 6).x}
                y2={polar(draftAngle, DEPTH_GAUGE_R + 6).y}
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
            </g>
          )}

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
              r={7}
              fill="#0a120c"
              stroke="#3dff6a"
              strokeWidth={2}
            />
            <circle cx={DEPTH_GAUGE_CX} cy={DEPTH_GAUGE_CY} r={2.5} fill="#7dff9a" />
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

        {children && <div className="depth-gauge-actions">{children}</div>}

        <p className="crt-console-caption depth-gauge-caption muted mono">
          0 · patrol {DIVE_BAND_MARKS[0].depthM} · test {FLEET_SUB_TEST_DEPTH_M} · crush{' '}
          {FLEET_SUB_CRUSH_DEPTH_M} · max {maxDepthM} m
        </p>
      </div>
    </div>
  );
}

export const DepthGauge = memo(DepthGaugeInner);
