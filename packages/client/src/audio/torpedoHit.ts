/**
 * Torpedo-hit explosion cue for Controls bridge speakers.
 * Short procedural burst (noise + low boom) — one cue per hit event.
 */

/** Peak gain on Controls at zero range (before distance attenuation). */
export const TORPEDO_HIT_CONTROLS_PEAK_GAIN = 0.55;

/**
 * Build a short one-shot explosion buffer (noise burst + decaying boom).
 * Cached per AudioContext by callers.
 */
export function synthesizeTorpedoHitBuffer(ctx: AudioContext): AudioBuffer {
  const durationSec = 0.55;
  const sampleRate = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, frames, sampleRate);
  const data = buffer.getChannelData(0);

  // Fixed LCG seed for a stable “sample” across sessions.
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t * 7.5);
    const boomEnv = Math.exp(-t * 4.2);
    const noise = (rand() * 2 - 1) * env * 0.55;
    const boom = Math.sin(2 * Math.PI * (55 + t * 30) * t) * boomEnv * 0.85;
    const crack = Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 28) * 0.35;
    data[i] = noise + boom + crack;
  }
  return buffer;
}

/** One-shot playback of the torpedo-hit buffer into `destination`. */
export function playTorpedoHitSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
): void {
  if (peakGain < 0.001) return;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peakGain), now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.min(0.7, buffer.duration));
  source.connect(gain);
  gain.connect(destination);
  source.start();
}
