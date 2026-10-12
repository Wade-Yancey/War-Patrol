/**
 * Vessel-sunk / hull-implosion aftermath (hydrophone one-shot).
 * Plays when a waterborne hull enters sinking / sunk within hearing range.
 */
export const SHIP_SINK_AFTERMATH_SAMPLE_URL = '/audio/ship-sink-aftermath.wav';

/**
 * Peak gain for a hydro-heard sink aftermath given range×beam gain in [0, 1].
 * Longer bed than DC (~44 s) — sit under detonation peaks so it fills the
 * listen mix without dominating the master bus.
 */
export function hydrophoneShipSinkAftermathPeakGain(contactGain: number): number {
  return Math.min(0.55, 0.14 + contactGain * 0.5);
}

export async function loadShipSinkAftermathBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(SHIP_SINK_AFTERMATH_SAMPLE_URL);
  if (!res.ok) throw new Error(`Ship-sink aftermath sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayShipSinkAftermathOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/** One-shot playback of the sink-aftermath sample into `destination`. */
export function playShipSinkAftermathSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayShipSinkAftermathOptions = {},
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
