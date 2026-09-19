/** Quiet looping facility hum for the Controls station (BT speakers). */
export const CONTROLS_AMBIENT_SAMPLE_URL = '/audio/controls-ambient-hum.wav';

/** Master gain for the ambient bed — keep below one-shot bridge cues. */
export const CONTROLS_AMBIENT_GAIN = 0.08;

export async function loadControlsAmbientBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(CONTROLS_AMBIENT_SAMPLE_URL);
  if (!res.ok) throw new Error(`Controls ambient sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

/**
 * Start a seamless loop of the ambient sample into `destination`.
 * Caller must stop/disconnect the returned source on teardown.
 */
export function startControlsAmbientLoop(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  gainValue: number = CONTROLS_AMBIENT_GAIN,
): { source: AudioBufferSourceNode; gain: GainNode } {
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain);
  gain.connect(destination);
  source.start(0);
  return { source, gain };
}
