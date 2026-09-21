import { useEffect, useRef } from 'react';
import { normalizeHeading, shortestBearingDelta } from '@war-patrol/shared';

/**
 * Map a wrapped 0–360° bearing to a continuous CSS rotation angle so
 * `transition: transform` always interpolates the shortest arc across 000°
 * (e.g. 350→10 becomes 350→370 instead of spinning ~340° the long way).
 *
 * Presentation only — does not change bearing math or displayed readouts.
 */
export function useContinuousAngle(bearingDeg: number): number {
  const target = normalizeHeading(bearingDeg);
  const continuousRef = useRef(target);
  // Delta must use a wrapped "from" — shared shortestBearingDelta assumes
  // 0–360 inputs; the continuous accumulator itself may grow past that.
  const display =
    continuousRef.current +
    shortestBearingDelta(normalizeHeading(continuousRef.current), target);

  useEffect(() => {
    continuousRef.current = display;
  });

  return display;
}
