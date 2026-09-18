/** Shared active-search sonar ping sample (destroyer Sensors + hydrophone hear). */
export const SONAR_PING_SAMPLE_URL = '/audio/sonar-ping.wav';

/** Own-set peak gain when search sonar is ON (Sensors screen). */
export const SONAR_PING_OWN_GAIN = 0.32;

/** Peak gain for a hydrophone-heard ping given range×beam gain in [0, 1]. */
export function hydrophonePingPeakGain(contactGain: number): number {
  return Math.min(0.28, 0.08 + contactGain * 0.35);
}

export async function loadSonarPingBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(SONAR_PING_SAMPLE_URL);
  if (!res.ok) throw new Error(`Sonar ping sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

/**
 * One-shot playback of the ping sample into `destination`.
 * Sample is ~2.7 s; interval may overlap slightly — intentional.
 */
export function playSonarPingSample(
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
