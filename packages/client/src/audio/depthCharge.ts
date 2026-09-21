import { DEPTH_CHARGE_CONTROLS_AUDIBLE_NM } from '@war-patrol/shared';

/** Depth-charge detonation sample (hydrophone + close Controls bridge). */
export const DEPTH_CHARGE_SAMPLE_URL = '/audio/depth-charge.wav';

/**
 * Peak gain on Controls when a charge detonates on top of own ship (range ≈ 0).
 * Raised above the old 0.42 so nearby blasts read clearly vs ambient/creak;
 * kept under 1.0 to avoid GainNode clipping on hot sample peaks.
 */
export const DEPTH_CHARGE_CONTROLS_GAIN = 0.9;

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

/**
 * Map each depth-charge bridge cue id → stagger delay (seconds), using the same
 * sort + formula as Controls / hydrophone one-shot scheduling.
 */
export function depthChargeBatchWhenSecById(
  events: ReadonlyArray<{ id: string }>,
): Map<string, number> {
  const sorted = events.slice().sort((a, b) => a.id.localeCompare(b.id));
  const n = sorted.length;
  return new Map(sorted.map((e, i) => [e.id, depthChargeStaggerDelaySec(i, n)]));
}

/**
 * Controls bridge gain factor [0, 1] from range to the detonation point.
 *
 * - Silent at / beyond {@link DEPTH_CHARGE_CONTROLS_AUDIBLE_NM} (server also
 *   filters bridge cues past this radius).
 * - Cubic falloff: `t = 1 - range / rMax`, factor = `t³` — near/far contrast
 *   is obvious (half-range ≈ 1/8 loudness); edge-of-nearby is near-silent.
 * Applied **per charge** (each pattern member uses its own `rangeNm`).
 *
 * Peak playback gain = {@link DEPTH_CHARGE_CONTROLS_GAIN} × this factor.
 */
export function depthChargeControlsGain(rangeNm: number): number {
  const r = Math.max(0, rangeNm);
  const rMax = DEPTH_CHARGE_CONTROLS_AUDIBLE_NM;
  if (!(rMax > 0) || r >= rMax) return 0;
  const t = 1 - r / rMax;
  return t * t * t;
}

/** Peak gain for hydrophone-heard detonation given range×beam gain in [0, 1]. */
export function hydrophoneDepthChargePeakGain(contactGain: number): number {
  return Math.min(0.72, 0.16 + contactGain * 0.7);
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
