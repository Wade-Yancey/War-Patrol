import { useEffect, useRef, useState } from 'react';
import { IMPLOSION_DEPTH_REVEAL_EPS_M } from '@war-patrol/shared';
import { CONTACT_TWEEN_MS } from './useTweenedScopeContacts';

/** Tick while a depth tween is active — same cadence as heading / contact crawl. */
const TWEEN_TICK_MS = 50;
/** Idle tick when the needle is at rest. */
const IDLE_TICK_MS = 200;
/** Ignore sub-meter noise when deciding whether to restart a tween. */
const DEPTH_EPS_M = IMPLOSION_DEPTH_REVEAL_EPS_M;

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
  return track.from + (track.to - track.from) * e;
}

function isTweening(track: Track, now: number): boolean {
  return now - track.tweenStartedAt < CONTACT_TWEEN_MS;
}

/**
 * Animate displayed keel depth from previous → new over {@link CONTACT_TWEEN_MS}
 * (same wall-clock window and ease-in-out as helm HDG / sensor contact tween).
 * Mid-animation target updates restart from the current displayed depth.
 * `null`/`undefined` clears the track so the first real keel snaps at rest
 * (no entrance crawl from 0 when the vessel view first arrives).
 * Presentation only — does not affect order entry or server state.
 */
export function useTweenedDepth(depthM: number | null | undefined): number {
  const armed = depthM != null && Number.isFinite(depthM);
  const target = armed ? (depthM as number) : 0;
  const [now, setNow] = useState(() => Date.now());
  const trackRef = useRef<Track | null>(null);

  useEffect(() => {
    const t = Date.now();
    if (!armed) {
      trackRef.current = null;
      setNow(t);
      return;
    }

    const prev = trackRef.current;
    if (!prev) {
      trackRef.current = {
        from: target,
        to: target,
        // Already at rest — no entrance crawl from an invented depth.
        tweenStartedAt: t - CONTACT_TWEEN_MS,
      };
      setNow(t);
      return;
    }

    if (Math.abs(prev.to - target) > DEPTH_EPS_M) {
      trackRef.current = {
        from: interpolate(prev, t),
        to: target,
        tweenStartedAt: t,
      };
      setNow(t);
    } else {
      trackRef.current = { ...prev, to: target };
    }
  }, [armed, target]);

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
  }, [armed, target]);

  const track = trackRef.current;
  if (!track) return target;
  return interpolate(track, now);
}
