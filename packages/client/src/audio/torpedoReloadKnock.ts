/**
 * Torpedo-room reload mechanical knock (hydro listeners + own Controls).
 * Replaces the tube-door sample on the `torpedo_reload` cue path.
 */
export const TORPEDO_RELOAD_KNOCK_SAMPLE_URL = '/audio/torpedo-reload-knock.mp3';

/** How many knocks per acoustic reload turn (keep sparse — not spam). */
export const TORPEDO_RELOAD_KNOCK_COUNT = 2;

/**
 * Wall-clock gap between knocks in a couplet.
 * Sample is ~4.6 s; short overlap keeps the room busy without a long monologue.
 */
export const TORPEDO_RELOAD_KNOCK_GAP_SEC = 1.8;

/** Peak gain on submarine Controls (own crew). */
export const TORPEDO_RELOAD_KNOCK_CONTROLS_PEAK_GAIN = 0.28;

/** Peak gain for a hydro-heard reload knock (scaled by contact gain). */
export function hydrophoneReloadKnockPeakGain(contactGain: number): number {
  return Math.min(0.45, 0.12 + contactGain * 0.4);
}

export async function loadTorpedoReloadKnockBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(TORPEDO_RELOAD_KNOCK_SAMPLE_URL);
  if (!res.ok) throw new Error(`Torpedo-reload knock sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayTorpedoReloadKnockOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/** One-shot knock into `destination`. */
export function playTorpedoReloadKnockSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayTorpedoReloadKnockOptions = {},
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

/**
 * Schedule a short couplet of knocks (default {@link TORPEDO_RELOAD_KNOCK_COUNT}).
 * Returns onset times relative to now for callers that need bookkeeping.
 */
export function playTorpedoReloadKnockCouplet(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: { count?: number; gapSec?: number; whenSec?: number } = {},
): void {
  const count = Math.max(1, options.count ?? TORPEDO_RELOAD_KNOCK_COUNT);
  const gapSec = Math.max(0, options.gapSec ?? TORPEDO_RELOAD_KNOCK_GAP_SEC);
  const base = Math.max(0, options.whenSec ?? 0);
  for (let i = 0; i < count; i++) {
    playTorpedoReloadKnockSample(ctx, buffer, destination, peakGain, {
      whenSec: base + i * gapSec,
    });
  }
}
