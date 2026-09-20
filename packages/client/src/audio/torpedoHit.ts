/**
 * Torpedo-hit explosion cue for Controls bridge speakers.
 * Short sample (or procedural fallback) — one cue per hit event.
 */

/** Bundled short explosion blast (noise + mid-bass boom). */
export const TORPEDO_HIT_SAMPLE_URL = '/audio/torpedo-hit.wav';

/** Peak gain on Controls at zero range (before distance attenuation). */
export const TORPEDO_HIT_CONTROLS_PEAK_GAIN = 0.78;

/**
 * Build a short one-shot explosion buffer (noise burst + audible boom).
 * Used only if the WAV sample cannot be fetched/decoded.
 * Energy is concentrated in midrange so laptop / BT speakers hear a blast,
 * not just a click (the prior synth’s ~55 Hz boom was inaudible on most kits).
 */
export function synthesizeTorpedoHitBuffer(ctx: AudioContext): AudioBuffer {
  const durationSec = 0.85;
  const sampleRate = ctx.sampleRate;
  const frames = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, frames, sampleRate);
  const data = buffer.getChannelData(0);

  // Fixed LCG seed for a stable “sample” across sessions.
  let seed = 0xc0ffee42;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const noiseEnv = Math.exp(-t * 4.8);
    const bodyEnv = Math.exp(-t * 2.8);
    const crackEnv = Math.exp(-t * 12);
    const noise = (rand() * 2 - 1) * noiseEnv;
    // Mid-bass boom + harmonics (audible on typical speakers — not sub-only).
    const boom =
      (Math.sin(2 * Math.PI * 88 * t) +
        0.7 * Math.sin(2 * Math.PI * 140 * t) +
        0.45 * Math.sin(2 * Math.PI * 210 * t) +
        0.25 * Math.sin(2 * Math.PI * 320 * t)) *
      bodyEnv;
    const crack =
      (Math.sin(2 * Math.PI * 780 * t) +
        0.7 * Math.sin(2 * Math.PI * 1250 * t) +
        0.4 * Math.sin(2 * Math.PI * 2100 * t)) *
      crackEnv;
    const grit = (rand() * 2 - 1) * Math.exp(-t * 18) * 0.55;
    const rumble = Math.sin(2 * Math.PI * (70 + t * 20) * t) * Math.exp(-t * 2.2) * 0.35;
    const s = noise * 0.85 + boom * 0.7 + crack * 0.55 + grit + rumble;
    data[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  const scale = peak > 0 ? 0.92 / peak : 1;
  for (let i = 0; i < frames; i++) data[i] *= scale;
  return buffer;
}

/** Load the bundled torpedo-hit WAV; falls back to procedural synth on failure. */
export async function loadTorpedoHitBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  try {
    const res = await fetch(TORPEDO_HIT_SAMPLE_URL);
    if (!res.ok) throw new Error(`Torpedo-hit sample fetch ${res.status}`);
    const raw = await res.arrayBuffer();
    return await ctx.decodeAudioData(raw.slice(0));
  } catch {
    return synthesizeTorpedoHitBuffer(ctx);
  }
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
  // Flat peak like depth-charge one-shots — sample already has its own envelope.
  // (Prior exponential ramp double-attenuated the blast body into a click.)
  gain.gain.value = peakGain;
  source.connect(gain);
  gain.connect(destination);
  source.start();
}
