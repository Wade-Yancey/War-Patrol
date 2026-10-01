import { useEffect, useRef, useState } from 'react';
import {
  normalizeHeading,
  shortestBearingDelta,
  type RadarContact,
} from '@war-patrol/shared';

/**
 * Wall-clock duration for contact polar moves after a sensor update (museum trial).
 * 20s: readable bearing/range crawl without eating most of the default ~180s
 * order window (was 60s); still longer than LOST_KEEP_MS so moves ≠ flash.
 */
export const CONTACT_TWEEN_MS = 20_000;

/** How long lost contacts linger while fading on the scope. */
const LOST_KEEP_MS = 8_000;

/** Tick while a tween / fade is active — smooth enough for a 20s crawl. */
const TWEEN_TICK_MS = 50;
/** Idle tick for sweep-fade housekeeping when nothing is moving. */
const IDLE_TICK_MS = 200;

export interface TweenedBlip extends RadarContact {
  /** Displayed (possibly mid-tween) true bearing. */
  displayBearing: number;
  /** Displayed (possibly mid-tween) range nm. */
  displayRangeNm: number;
  /** True when the contact is in the latest server set. */
  live: boolean;
  /** 0–1 opacity scale for lost contacts (1 = fully visible). */
  fade: number;
  bornAt: number;
  lastSeenAt: number;
  /**
   * Prior→new polar for a PPI motion cue (same Contact N / track id).
   * Absent for first-seen contacts (no invented direction).
   * During the 60s tween this is the active displacement; after settle it stays
   * until the next polar update. Screen direction is derived in the scope from
   * these polars at the current display scale (world-true as seen on the PPI).
   */
  motionFrom?: { bearing: number; rangeNm: number };
  motionTo?: { bearing: number; rangeNm: number };
}

interface Track {
  contact: RadarContact;
  fromBearing: number;
  fromRangeNm: number;
  toBearing: number;
  toRangeNm: number;
  tweenStartedAt: number;
  bornAt: number;
  lastSeenAt: number;
  live: boolean;
  /** Last prior→new polar pair for the motion chevron (undefined until 2nd fix). */
  motionFromBearing?: number;
  motionFromRangeNm?: number;
  motionToBearing?: number;
  motionToRangeNm?: number;
}

function contactsKey(contacts: RadarContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.bearing.toFixed(1)}:${c.rangeNm.toFixed(2)}:${c.strength}:${c.signature}:${c.domain}:${c.estimatedDepthM ?? ''}:${c.labelN}`,
    )
    .join('|');
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function polarChanged(
  a: { bearing: number; rangeNm: number },
  b: { bearing: number; rangeNm: number },
): boolean {
  return (
    Math.abs(shortestBearingDelta(a.bearing, b.bearing)) > 0.05 ||
    Math.abs(a.rangeNm - b.rangeNm) > 0.005
  );
}

function interpolatePolar(
  track: Pick<Track, 'fromBearing' | 'fromRangeNm' | 'toBearing' | 'toRangeNm' | 'tweenStartedAt'>,
  now: number,
): { bearing: number; rangeNm: number } {
  const elapsed = now - track.tweenStartedAt;
  const t = Math.min(1, Math.max(0, elapsed / CONTACT_TWEEN_MS));
  const e = easeInOut(t);
  const delta = shortestBearingDelta(track.fromBearing, track.toBearing);
  return {
    bearing: normalizeHeading(track.fromBearing + delta * e),
    rangeNm: track.fromRangeNm + (track.toRangeNm - track.fromRangeNm) * e,
  };
}

function hasMotion(map: Map<string, Track>, now: number): boolean {
  for (const track of map.values()) {
    if (track.live && now - track.tweenStartedAt < CONTACT_TWEEN_MS) return true;
    if (!track.live && now - track.lastSeenAt < LOST_KEEP_MS) return true;
  }
  return false;
}

/**
 * Animate polar scope blips from previous → new position over {@link CONTACT_TWEEN_MS}.
 * Same contact id tweens; new contacts appear at target; lost contacts fade then drop.
 * Mid-animation updates restart from the current displayed polar to the new target.
 * Own-ship is always PPI center (caller does not pass a previous-own mark).
 * When a contact gets a second (or later) polar fix, {@link TweenedBlip.motionFrom}/
 * {@link TweenedBlip.motionTo} carry that displacement for a PPI motion chevron —
 * first-seen contacts have no cue (no invented direction).
 */
export function useTweenedScopeContacts(contacts: RadarContact[]): TweenedBlip[] {
  const [now, setNow] = useState(() => Date.now());
  const tracksRef = useRef<Map<string, Track>>(new Map());
  const key = contactsKey(contacts);

  useEffect(() => {
    const map = tracksRef.current;
    const seen = new Set<string>();
    const t = Date.now();

    for (const c of contacts) {
      seen.add(c.id);
      const prev = map.get(c.id);
      if (!prev) {
        map.set(c.id, {
          contact: c,
          fromBearing: c.bearing,
          fromRangeNm: c.rangeNm,
          toBearing: c.bearing,
          toRangeNm: c.rangeNm,
          // Already at rest — no entrance crawl from an invented origin.
          tweenStartedAt: t - CONTACT_TWEEN_MS,
          bornAt: t,
          lastSeenAt: t,
          live: true,
          // First fix — no motion cue until a later polar update.
        });
        continue;
      }

      const displayed = interpolatePolar(prev, t);
      const targetChanged = polarChanged(
        { bearing: prev.toBearing, rangeNm: prev.toRangeNm },
        c,
      );
      if (targetChanged) {
        map.set(c.id, {
          contact: c,
          fromBearing: displayed.bearing,
          fromRangeNm: displayed.rangeNm,
          toBearing: c.bearing,
          toRangeNm: c.rangeNm,
          tweenStartedAt: t,
          bornAt: prev.bornAt,
          lastSeenAt: t,
          live: true,
          // Cue from previous settled (or mid-tween) polar → new server polar.
          motionFromBearing: displayed.bearing,
          motionFromRangeNm: displayed.rangeNm,
          motionToBearing: c.bearing,
          motionToRangeNm: c.rangeNm,
        });
      } else {
        map.set(c.id, {
          ...prev,
          contact: c,
          lastSeenAt: t,
          live: true,
        });
      }
    }

    for (const [id, track] of [...map.entries()]) {
      if (seen.has(id)) continue;
      if (t - track.lastSeenAt > LOST_KEEP_MS) {
        map.delete(id);
      } else {
        map.set(id, { ...track, live: false });
      }
    }

    setNow(t);
  }, [key, contacts]);

  useEffect(() => {
    let timer: number | null = null;
    const schedule = () => {
      const t = Date.now();
      const ms = hasMotion(tracksRef.current, t) ? TWEEN_TICK_MS : IDLE_TICK_MS;
      timer = window.setTimeout(() => {
        setNow(Date.now());
        // Drop fully faded lost tracks opportunistically.
        const map = tracksRef.current;
        const nowTs = Date.now();
        for (const [id, track] of [...map.entries()]) {
          if (!track.live && nowTs - track.lastSeenAt > LOST_KEEP_MS) {
            map.delete(id);
          }
        }
        schedule();
      }, ms);
    };
    schedule();
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [key]);

  const blips: TweenedBlip[] = [];
  for (const track of tracksRef.current.values()) {
    const { bearing, rangeNm } = interpolatePolar(track, now);
    const age = now - track.lastSeenAt;
    const fade = track.live ? 1 : Math.max(0, 1 - age / LOST_KEEP_MS);
    const hasMotion =
      track.motionFromBearing != null &&
      track.motionFromRangeNm != null &&
      track.motionToBearing != null &&
      track.motionToRangeNm != null;
    blips.push({
      ...track.contact,
      displayBearing: bearing,
      displayRangeNm: rangeNm,
      live: track.live,
      fade,
      bornAt: track.bornAt,
      lastSeenAt: track.lastSeenAt,
      ...(hasMotion
        ? {
            motionFrom: {
              bearing: track.motionFromBearing!,
              rangeNm: track.motionFromRangeNm!,
            },
            motionTo: {
              bearing: track.motionToBearing!,
              rangeNm: track.motionToRangeNm!,
            },
          }
        : {}),
    });
  }
  return blips;
}

/** PPI / cone scope polar → canvas XY (bearing 000 = up). */
export function scopePolarToXy(
  bearing: number,
  rangeNm: number,
  scaleNm: number,
  cx: number,
  cy: number,
  scopeR: number,
): { x: number; y: number } {
  const frac = Math.min(1, rangeNm / Math.max(scaleNm, 0.001));
  const rad = ((bearing - 90) * Math.PI) / 180;
  const r = frac * scopeR;
  return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
}

/**
 * Screen-space heading (degrees, SVG rotate: 0 = +x / east on PPI) of the
 * displacement from prior polar → new polar at the current display scale.
 * Returns null when the cue is missing or the on-scope move is negligible.
 */
export function scopeMotionAngleDeg(
  from: { bearing: number; rangeNm: number },
  to: { bearing: number; rangeNm: number },
  scaleNm: number,
  scopeR: number,
  /** Minimum on-scope pixel travel before a chevron is shown. */
  minPx = 4,
): number | null {
  const a = scopePolarToXy(from.bearing, from.rangeNm, scaleNm, 0, 0, scopeR);
  const b = scopePolarToXy(to.bearing, to.rangeNm, scaleNm, 0, 0, scopeR);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < minPx * minPx) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
