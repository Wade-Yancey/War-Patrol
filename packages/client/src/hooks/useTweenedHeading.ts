import { useEffect, useRef, useState } from 'react';
import { normalizeHeading, shortestBearingDelta } from '@war-patrol/shared';
import { CONTACT_TWEEN_MS } from './useTweenedScopeContacts';

/** Tick while a heading tween is active — same cadence as scope contact crawl. */
const TWEEN_TICK_MS = 50;
/** Idle tick when the needle is at rest. */
const IDLE_TICK_MS = 200;
/** Ignore sub-degree noise when deciding whether to restart a tween. */
const HEADING_EPS_DEG = 0.05;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

interface Track {
  from: number;
  to: number;
  tweenStartedAt: number;
}

function interpolate(track: Track, now: number): number {
  const elapsed = now - track.tweenStartedAt;
  const t = Math.min(1, Math.max(0, elapsed / CONTACT_TWEEN_MS));
  const e = easeInOut(t);
  const delta = shortestBearingDelta(track.from, track.to);
  return normalizeHeading(track.from + delta * e);
}

function isTweening(track: Track, now: number): boolean {
  return now - track.tweenStartedAt < CONTACT_TWEEN_MS;
}

/**
 * Animate displayed heading from previous → new over {@link CONTACT_TWEEN_MS}
 * (same wall-clock window and ease-in-out as radar / active-sonar contact polar tween).
 * Mid-animation target updates restart from the current displayed heading.
 * Presentation only — does not affect order entry or server state.
 */
export function useTweenedHeading(heading: number): number {
  const target = normalizeHeading(heading);
  const [now, setNow] = useState(() => Date.now());
  const trackRef = useRef<Track | null>(null);

  useEffect(() => {
    const t = Date.now();
    const prev = trackRef.current;
    if (!prev) {
      trackRef.current = {
        from: target,
        to: target,
        // Already at rest — no entrance crawl from an invented heading.
        tweenStartedAt: t - CONTACT_TWEEN_MS,
      };
      setNow(t);
      return;
    }

    if (Math.abs(shortestBearingDelta(prev.to, target)) > HEADING_EPS_DEG) {
      trackRef.current = {
        from: interpolate(prev, t),
        to: target,
        tweenStartedAt: t,
      };
      setNow(t);
    } else {
      trackRef.current = { ...prev, to: target };
    }
  }, [target]);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      const track = trackRef.current;
      const t = Date.now();
      const ms =
        track != null && isTweening(track, t) ? TWEEN_TICK_MS : IDLE_TICK_MS;
      timer = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, ms);
    };
    schedule();
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [target]);

  const track = trackRef.current;
  if (!track) return target;
  return interpolate(track, now);
}
