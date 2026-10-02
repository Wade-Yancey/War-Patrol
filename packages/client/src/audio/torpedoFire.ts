/** Torpedo tube-door report (Controls bridge — firer submarine). */
export const TORPEDO_FIRE_SAMPLE_URL = '/audio/torpedo-tube-door.mp3';

/**
 * Peak gain on Controls for the tube-door cue.
 * Kept quiet for speaker ambience (well under deck-gun's 0.7 own-ship report).
 */
export const TORPEDO_FIRE_CONTROLS_PEAK_GAIN = 0.25;

/**
 * Wall-clock gap (seconds) between tube-door onsets in a multi-fish salvo.
 * Kept in sync with shared TORPEDO_FIRE_STAGGER_SEC (0.8 s) — short enough for
 * a successive salvo feel, long enough that overlapping doors stay countable.
 */
export const TORPEDO_FIRE_SAME_MOMENT_STAGGER_SEC = 0.8;

export async function loadTorpedoFireBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(TORPEDO_FIRE_SAMPLE_URL);
  if (!res.ok) throw new Error(`Torpedo-fire sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayTorpedoFireOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/**
 * Map each torpedo-fire cue id → playback `whenSec`.
 *
 * Prefer server `audioDelaySec` (already staggered per fish). Events that
 * share the same base delay still get a short same-moment split so stacked
 * cues remain countable if delays collide.
 */
export function torpedoFireBatchWhenSecById(
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
    out.set(e.id, base + groupIndex * TORPEDO_FIRE_SAME_MOMENT_STAGGER_SEC);
    groupIndex += 1;
  }
  return out;
}

/** One-shot playback of the tube-door sample into `destination`. */
export function playTorpedoFireSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayTorpedoFireOptions = {},
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
