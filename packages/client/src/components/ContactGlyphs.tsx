/**
 * Shared PPI / umpire-map glyphs for radar / sonar contacts.
 * All contacts use concentric round blips; known course paints a facing chevron.
 * (Aircraft top-down silhouette glyphs were removed temporarily — orientation TBD.)
 */

interface RadarBlipProps {
  x: number;
  y: number;
  /** Strength-scaled radius used for ship dots. */
  r: number;
}

/** Concentric CRT echo — surface / submarine / ship / air contacts. */
export function RadarSurfaceBlip({ x, y, r }: RadarBlipProps) {
  return (
    <>
      <circle cx={x} cy={y} r={r + 2} fill="none" stroke="#7dff9a" strokeWidth={1.5} />
      <circle cx={x} cy={y} r={r} fill="#b8ffc8" />
      <circle cx={x} cy={y} r={Math.max(2, r * 0.45)} fill="#e8ffe8" />
    </>
  );
}

interface MotionChevronProps {
  x: number;
  y: number;
  /**
   * True course / facing degrees (0 = north / up on PPI).
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
