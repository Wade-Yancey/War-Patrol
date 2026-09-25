/** Deck-gun muzzle report (Controls bridge — firer). */
export const DECK_GUN_FIRE_SAMPLE_URL = '/audio/deck-gun-fire.wav';

/** Peak gain on Controls for the cannon fire cue. */
export const DECK_GUN_FIRE_CONTROLS_PEAK_GAIN = 0.7;

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
