/** Deck-gun muzzle report (Controls bridge — firer). */
export const DECK_GUN_FIRE_SAMPLE_URL = '/audio/deck-gun-fire.wav';

/** Peak gain on Controls for the cannon fire cue. */
export const DECK_GUN_FIRE_CONTROLS_PEAK_GAIN = 0.7;

/**
 * Wall-clock gap (seconds) between cannon onsets in a multi-shot salvo.
 * Kept in sync with shared DECK_GUN_FIRE_STAGGER_SEC (2 s) — slow enough that
 * reports are clearly separated, matching the reduced ROF feel.
 */
export const DECK_GUN_FIRE_SAME_MOMENT_STAGGER_SEC = 2;

export async function loadDeckGunFireBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(DECK_GUN_FIRE_SAMPLE_URL);
  if (!res.ok) throw new Error(`Deck-gun fire sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayDeckGunFireOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/**
 * Map each deck-gun fire cue id → playback `whenSec`.
 *
 * Prefer server `audioDelaySec` (already staggered per round). Events that
 * share the same base delay still get a short same-moment split so stacked
 * cues remain countable if delays collide.
 */
export function deckGunFireBatchWhenSecById(
  events: ReadonlyArray<{ id: string; audioDelaySec?: number }>,
): Map<string, number> {
  const sorted = events.slice().sort((a, b) => {
    const da = Math.max(0, a.audioDelaySec ?? 0);
    const db = Math.max(0, b.audioDelaySec ?? 0);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
  const out = new Map<string, number>();
  let groupKeyMs = Number.NaN;
  let groupIndex = 0;
  for (const e of sorted) {
    const base = Math.max(0, e.audioDelaySec ?? 0);
    const keyMs = Math.round(base * 1000);
    if (keyMs !== groupKeyMs) {
      groupKeyMs = keyMs;
      groupIndex = 0;
    }
    out.set(e.id, base + groupIndex * DECK_GUN_FIRE_SAME_MOMENT_STAGGER_SEC);
    groupIndex += 1;
  }
  return out;
}

/** One-shot playback of the cannon fire sample into `destination`. */
export function playDeckGunFireSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayDeckGunFireOptions = {},
): void {
  if (peakGain < 0.001) return;
  const whenSec = Math.max(0, options.whenSec ?? 0);
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = peakGain;
  source.connect(gain);
  gain.connect(destination);
  source.start(ctx.currentTime + whenSec);
}
