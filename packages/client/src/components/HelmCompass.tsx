import { memo } from 'react';
import { normalizeHeading, shortestBearingDelta } from '@war-patrol/shared';
import { useContinuousAngle } from '../hooks/useContinuousAngle';
import {
  COMPASS_CX,
  COMPASS_CY,
  COMPASS_R,
  COMPASS_SIZE,
  CrtCompassDashedBug,
  CrtCompassHdgNeedle,
  CrtCompassHub,
  CrtCompassRoseFace,
} from './CrtCompassRose';

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

/**
 * CRT gyro-style compass for the helmsman: north-up rose with distinct
 * heading needle and ordered-course bug. Live unit state only — no fake data.
 */
function HelmCompassInner({ heading, orderedCourse, draftCourse, turnRate }: Props) {
  const hdg = normalizeHeading(heading);
  const crs = normalizeHeading(orderedCourse);
  const draft =
    draftCourse === undefined ? undefined : normalizeHeading(draftCourse);
  const draftRotateDeg = useContinuousAngle(draft ?? 0);

  const showDraft =
    draft !== undefined && Math.abs(shortestBearingDelta(crs, draft)) > 0.5;
  const onCourse = Math.abs(shortestBearingDelta(hdg, crs)) < 0.75;

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
        viewBox={`0 0 ${COMPASS_SIZE} ${COMPASS_SIZE}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <CrtCompassRoseFace>
          {/* Ordered course — dashed needle + rim chevron. */}
          <CrtCompassDashedBug bearing={crs} className="helm-compass-needle" />

          {/* Draft SET mark (pre-submit), only when it differs from CRS. */}
          {showDraft && draft !== undefined && (
            <g
              className="helm-compass-needle helm-compass-draft"
              style={{
                transform: `rotate(${draftRotateDeg}deg)`,
                transformOrigin: `${COMPASS_CX}px ${COMPASS_CY}px`,
              }}
              opacity={0.55}
            >
              <circle
                cx={COMPASS_CX}
                cy={COMPASS_CY - (COMPASS_R + 16)}
                r={5}
                fill="none"
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
              <line
                x1={COMPASS_CX}
                y1={COMPASS_CY - (COMPASS_R - 6)}
                x2={COMPASS_CX}
                y2={COMPASS_CY - (COMPASS_R + 8)}
                stroke="#7dff9a"
                strokeWidth={1.5}
              />
            </g>
          )}

          <CrtCompassHdgNeedle bearing={hdg} className="helm-compass-needle" />
          <CrtCompassHub />
        </CrtCompassRoseFace>
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
