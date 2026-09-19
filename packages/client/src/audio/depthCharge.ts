/** Depth-charge detonation sample (hydrophone + close Controls bridge). */
export const DEPTH_CHARGE_SAMPLE_URL = '/audio/depth-charge.wav';

/** Peak gain on Controls when a charge detonates very close. */
export const DEPTH_CHARGE_CONTROLS_GAIN = 0.42;

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

/** One-shot playback of the DC sample into `destination`. */
export function playDepthChargeSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
): void {
  if (peakGain < 0.001) return;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = peakGain;
  source.connect(gain);
  gain.connect(destination);
  source.start();
}
