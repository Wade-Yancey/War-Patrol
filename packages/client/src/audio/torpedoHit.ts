/** Torpedo-hit explosion sample (Controls bridge — firer + target). */
export const TORPEDO_HIT_SAMPLE_URL = '/audio/explosion.wav';

/**
 * Peak gain on Controls at zero range (before distance attenuation).
 * Modest bump vs the prior 0.72 so scored hits read clearly without clipping.
 */
export const TORPEDO_HIT_CONTROLS_PEAK_GAIN = 0.82;

export async function loadTorpedoHitBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(TORPEDO_HIT_SAMPLE_URL);
  if (!res.ok) throw new Error(`Torpedo-hit sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayTorpedoHitOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/** One-shot playback of the explosion sample into `destination`. */
export function playTorpedoHitSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayTorpedoHitOptions = {},
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
