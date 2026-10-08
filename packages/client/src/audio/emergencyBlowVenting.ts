/** Emergency-blow ballast venting one-shot for submarine Controls. */
export const EMERGENCY_BLOW_VENTING_SAMPLE_URL = '/audio/emergency-blow-venting.wav';

/**
 * Peak gain for the venting cue on submarine Controls.
 * Sits above the ducked depth-change bed during Emergency Blow so the hiss
 * stays clear on speakers.
 */
export const EMERGENCY_BLOW_VENTING_PEAK_GAIN = 0.92;

/**
 * Depth-change bed gain while an Emergency Blow ascent resolves.
 * Duck under venting so the 28 s underwater clip does not bury the hiss.
 */
export const SUB_DEPTH_CHANGE_EMERGENCY_BLOW_GAIN = 0.32;

export async function loadEmergencyBlowVentingBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(EMERGENCY_BLOW_VENTING_SAMPLE_URL);
  if (!res.ok) throw new Error(`Emergency-blow venting sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayEmergencyBlowVentingOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/**
 * One-shot ballast-vent cue into the Controls bridge destination.
 * Prefer the unlocked bridge `AudioContext` so resolve-time playback is not
 * gated on a fresh suspended context.
 */
export function playEmergencyBlowVentingSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayEmergencyBlowVentingOptions = {},
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
