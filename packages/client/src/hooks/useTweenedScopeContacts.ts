import { useEffect, useRef, useState } from 'react';
import {
  normalizeHeading,
  shortestBearingDelta,
  type RadarContact,
} from '@war-patrol/shared';

/** Wall-clock duration for contact polar moves after a sensor update (museum trial). */
export const CONTACT_TWEEN_MS = 60_000;

/** How long lost contacts linger while fading on the scope. */
const LOST_KEEP_MS = 8_000;

/** Tick while a tween / fade is active — smooth enough for a 60s crawl. */
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
}

function contactsKey(contacts: RadarContact[]): string {
  return contacts
    .map(
      (c) =>
        `${c.id}:${c.bearing.toFixed(1)}:${c.rangeNm.toFixed(2)}:${c.strength}:${c.signature}:${c.estimatedDepthM ?? ''}:${c.labelN}`,
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
    blips.push({
      ...track.contact,
      displayBearing: bearing,
      displayRangeNm: rangeNm,
      live: track.live,
      fade,
      bornAt: track.bornAt,
      lastSeenAt: track.lastSeenAt,
    });
  }
  return blips;
}
