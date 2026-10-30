/**
 * Shared PPI / umpire-map glyphs for surface vs air contacts.
 * Aircraft use a top-down silhouette (nose up in local coords); ships keep round blips.
 * Player radar may paint domain `air` without naming class/side (Cn labels unchanged).
 */

/** Nose-up top-down fighter outline — approximate wings + fuselage + tail. */
export const AIRCRAFT_TOPDOWN_PATH =
  'M 0,-7.5 L 1.6,-1.8 L 7.5,0.8 L 7.5,2.4 L 1.8,0.9 L 1.2,5.2 L 3.8,7 L 3.8,8 L 0,6.2 L -3.8,8 L -3.8,7 L -1.2,5.2 L -1.8,0.9 L -7.5,2.4 L -7.5,0.8 L -1.6,-1.8 Z';

interface RadarBlipProps {
  x: number;
  y: number;
  /** Strength-scaled radius used for ship dots and aircraft scale. */
  r: number;
}

interface RadarAirBlipProps extends RadarBlipProps {
  /**
   * True course / facing degrees (0 = north / up on PPI) — same convention as
   * {@link RadarMotionChevron} and {@link MapAircraftMarker}. When omitted or
   * non-finite, glyph stays nose-up (unrotated), matching the no-chevron case.
   */
  courseDeg?: number | null;
}

/** Concentric CRT echo — surface / submarine / ship contacts. */
export function RadarSurfaceBlip({ x, y, r }: RadarBlipProps) {
  return (
    <>
      <circle cx={x} cy={y} r={r + 2} fill="none" stroke="#7dff9a" strokeWidth={1.5} />
      <circle cx={x} cy={y} r={r} fill="#b8ffc8" />
      <circle cx={x} cy={y} r={Math.max(2, r * 0.45)} fill="#e8ffe8" />
    </>
  );
}

/**
 * Aircraft PPI glyph — small top-down silhouette (not a round ship blip).
 * Rotates with FoW `courseDeg` when known (same angle as the facing chevron);
 * otherwise stays nose-up.
 */
export function RadarAirBlip({ x, y, r, courseDeg }: RadarAirBlipProps) {
  const scale = Math.max(0.9, r / 5.2);
  const facing =
    courseDeg != null && Number.isFinite(courseDeg) ? ` rotate(${courseDeg})` : '';
  return (
    <g transform={`translate(${x} ${y})${facing} scale(${scale})`} aria-label="Air contact">
      <path
        d={AIRCRAFT_TOPDOWN_PATH}
        fill="#b8ffc8"
        stroke="#7dff9a"
        strokeWidth={1.15 / scale}
        strokeLinejoin="round"
      />
      <circle cx={0} cy={-1.2} r={1.15} fill="#e8ffe8" />
    </g>
  );
}

interface MapAircraftProps {
  x: number;
  y: number;
  /** True heading degrees — rotates nose to course. */
  heading: number;
  color: string;
  opacity?: number;
  /** Rough half-span for label clearance (~ship ring r=8). */
  size?: number;
}

/** Umpire GT map aircraft marker — heading-aligned silhouette, no ship ring. */
export function MapAircraftMarker({
  x,
  y,
  heading,
  color,
  opacity = 1,
  size = 9,
}: MapAircraftProps) {
  const scale = size / 8;
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${heading}) scale(${scale})`}
      opacity={opacity}
      aria-label="Aircraft"
    >
      <path
        d={AIRCRAFT_TOPDOWN_PATH}
        fill={color}
        stroke={color}
        strokeWidth={1.1 / scale}
        strokeLinejoin="round"
        fillOpacity={0.92}
      />
      <circle cx={0} cy={-1.2} r={1.1} fill={color} fillOpacity={0.55} />
    </g>
  );
}

interface MotionChevronProps {
  x: number;
  y: number;
  /**
   * True course / facing degrees (0 = north / up on PPI) — same convention as
   * {@link MapAircraftMarker} heading rotate.
   */
  courseDeg: number;
  /** Blip radius; chevron sits just beyond the echo. */
  blipR: number;
}

/**
 * Small PPI / sonar facing cue — one chevron per contact with known course,
 * pointing the way the contact is facing (true heading), not tween displacement.
 */
export function RadarMotionChevron({ x, y, courseDeg, blipR }: MotionChevronProps) {
  const tip = blipR + 3;
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${courseDeg})`}
      aria-label="Contact facing direction"
    >
      {/* Nose-up V (0° = north / up); rotate by true course. */}
      <path
        d={`M -4.5,${-tip} L 0,${-(tip + 9)} L 4.5,${-tip}`}
        fill="none"
        stroke="#b8ffc8"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </g>
  );
}
