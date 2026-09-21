/** Depth-charge detonation sample (hydrophone + close Controls bridge). */
export const DEPTH_CHARGE_SAMPLE_URL = '/audio/depth-charge.wav';

/** Peak gain on Controls when a charge detonates very close. */
export const DEPTH_CHARGE_CONTROLS_GAIN = 0.42;

/**
 * Wall-clock window (seconds) over which a multi-charge pattern's one-shots are
 * spread on the client. Server resolve still applies all effects in one turn;
 * audio only is staggered so N blasts are not stacked into a single hit.
 */
export const DEPTH_CHARGE_AUDIO_SPREAD_SEC = 120;

/**
 * Delay (seconds) for the `index`-th of `count` depth-charge one-shots in a
 * simultaneous hear-batch (Controls bridge or hydrophone).
 *
 * - `count <= 1` → 0
 * - else evenly from 0 … {@link DEPTH_CHARGE_AUDIO_SPREAD_SEC}:
 *   `delay = index / (count - 1) * 120`
 */
export function depthChargeStaggerDelaySec(index: number, count: number): number {
  const n = Math.max(0, Math.floor(count));
  const i = Math.max(0, Math.floor(index));
  if (n <= 1 || i <= 0) return 0;
  if (i >= n - 1) return DEPTH_CHARGE_AUDIO_SPREAD_SEC;
  return (i / (n - 1)) * DEPTH_CHARGE_AUDIO_SPREAD_SEC;
}

/** Peak gain for hydrophone-heard detonation given range×beam gain in [0, 1]. */
export function hydrophoneDepthChargePeakGain(contactGain: number): number {
  return Math.min(0.5, 0.12 + contactGain * 0.55);
}

export async function loadDepthChargeBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(DEPTH_CHARGE_SAMPLE_URL);
  if (!res.ok) throw new Error(`Depth-charge sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayDepthChargeOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/** One-shot playback of the DC sample into `destination`. */
export function playDepthChargeSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayDepthChargeOptions = {},
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
