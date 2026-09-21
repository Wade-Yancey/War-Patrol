import {
  DEPTH_CHARGE_CONTROLS_AUDIBLE_NM,
  DEPTH_CHARGE_RANGE_CLOSE_M,
  DEPTH_CHARGE_RANGE_FAR_M,
  DEPTH_CHARGE_RANGE_MED_M,
  METERS_PER_NM,
} from '@war-patrol/shared';

/** Depth-charge detonation sample (hydrophone + close Controls bridge). */
export const DEPTH_CHARGE_SAMPLE_URL = '/audio/depth-charge.wav';

/**
 * Peak gain on Controls when a charge detonates on top of own ship (range ≈ 0)
 * before the damage-band multiplier. Slightly above 0.9 so nearby blasts read
 * over ambient/creak; still under 1.0 to avoid GainNode clipping on hot peaks.
 */
export const DEPTH_CHARGE_CONTROLS_GAIN = 0.98;

/**
 * Hard ceiling for Controls DC one-shot gain after damage-band boost.
 * Keeps “this one hurt” loud without always slamming into GainNode clip.
 */
export const DEPTH_CHARGE_CONTROLS_PEAK_CEILING = 0.99;

/**
 * Extra gain multipliers when the blast is inside the sim damage / stun bands
 * (horizontal miss ≤ {@link DEPTH_CHARGE_RANGE_CLOSE_M} / MED / FAR meters).
 * Applied on top of quintic range falloff so kill-radius charges read louder
 * than mid/far near-misses that are only acoustically audible.
 */
export const DEPTH_CHARGE_DAMAGE_BAND_GAIN = {
  close: 1.25,
  med: 1.18,
  far: 1.12,
} as const;

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
 * - Quintic falloff: `t = 1 - range / rMax`, factor = `t⁵` — wider near/far
 *   dynamic range than the prior cubic (`t³`): close blasts stay near peak,
 *   mid/far drop faster (half-range ≈ 1/32 loudness vs cubic’s ≈ 1/8).
 * Applied **per charge** (each pattern member uses its own `rangeNm`).
 *
 * Playback peak also multiplies {@link depthChargeDamageBandMultiplier} and is
 * capped by {@link DEPTH_CHARGE_CONTROLS_PEAK_CEILING} — see
 * {@link depthChargeControlsPeakGain}.
 */
export function depthChargeControlsGain(rangeNm: number): number {
  const r = Math.max(0, rangeNm);
  const rMax = DEPTH_CHARGE_CONTROLS_AUDIBLE_NM;
  if (!(rMax > 0) || r >= rMax) return 0;
  const t = 1 - r / rMax;
  // t⁵ — steeper than cubic so quiets are quieter while near stays loud.
  const t2 = t * t;
  return t2 * t2 * t;
}

/**
 * Damage / stun band multiplier from horizontal range to the blast (own ship).
 * 1.0 outside {@link DEPTH_CHARGE_RANGE_FAR_M}; stepped boost inside close/med/far.
 */
export function depthChargeDamageBandMultiplier(rangeNm: number): number {
  const rangeM = Math.max(0, rangeNm) * METERS_PER_NM;
  if (rangeM <= DEPTH_CHARGE_RANGE_CLOSE_M) return DEPTH_CHARGE_DAMAGE_BAND_GAIN.close;
  if (rangeM <= DEPTH_CHARGE_RANGE_MED_M) return DEPTH_CHARGE_DAMAGE_BAND_GAIN.med;
  if (rangeM <= DEPTH_CHARGE_RANGE_FAR_M) return DEPTH_CHARGE_DAMAGE_BAND_GAIN.far;
  return 1;
}

/**
 * Final Controls DC one-shot peak gain for a bridge cue.
 *
 * `DEPTH_CHARGE_CONTROLS_GAIN × quintic(range) × damageBand(range)`, clamped to
 * {@link DEPTH_CHARGE_CONTROLS_PEAK_CEILING} so kill-radius blasts stay loud
 * without always clipping.
 */
export function depthChargeControlsPeakGain(rangeNm: number): number {
  const base = DEPTH_CHARGE_CONTROLS_GAIN * depthChargeControlsGain(rangeNm);
  if (base < 0.001) return 0;
  return Math.min(
    DEPTH_CHARGE_CONTROLS_PEAK_CEILING,
    base * depthChargeDamageBandMultiplier(rangeNm),
  );
}

/** Peak gain for hydrophone-heard detonation given range×beam gain in [0, 1]. */
export function hydrophoneDepthChargePeakGain(contactGain: number): number {
  return Math.min(0.85, 0.18 + contactGain * 0.78);
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
