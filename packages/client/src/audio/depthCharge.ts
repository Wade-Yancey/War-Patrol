import {
  DEPTH_CHARGE_CONTROLS_AUDIBLE_NM,
  DEPTH_CHARGE_RANGE_CLOSE_M,
  DEPTH_CHARGE_RANGE_FAR_M,
  DEPTH_CHARGE_RANGE_MED_M,
  METERS_PER_NM,
} from '@war-patrol/shared';

/** {@link DEPTH_CHARGE_RANGE_FAR_M} expressed in NM — the outer edge of the sim
 * damage/stun bands, used as the pivot for the extra long-range taper below. */
const DEPTH_CHARGE_RANGE_FAR_NM = DEPTH_CHARGE_RANGE_FAR_M / METERS_PER_NM;

/** Depth-charge detonation sample (hydrophone + close Controls bridge). */
export const DEPTH_CHARGE_SAMPLE_URL = '/audio/depth-charge.wav';

/**
 * Peak gain on Controls when a charge detonates on top of own ship (range ≈ 0)
 * before the damage-band multiplier. Set to the max intentional ceiling (1.0)
 * so a point-blank, damage-dealing charge reads as loud as the engine allows —
 * dynamic range is carved out below this by quintic range falloff and the
 * damage-band multiplier, not by holding this peak back.
 */
export const DEPTH_CHARGE_CONTROLS_GAIN = 1.0;

/**
 * Hard ceiling for Controls DC one-shot gain after the damage-band multiplier.
 * 1.0 — the max intentional gain — so a close, damage-dealing blast can sit
 * exactly at the top of the curve. Every other range/band sits strictly below
 * this via {@link depthChargeControlsGain} and {@link DEPTH_CHARGE_DAMAGE_BAND_GAIN}.
 */
export const DEPTH_CHARGE_CONTROLS_PEAK_CEILING = 1.0;

/**
 * Gain multipliers from horizontal miss distance to the sim damage / stun
 * bands (≤ {@link DEPTH_CHARGE_RANGE_CLOSE_M} / MED / FAR meters), stacked on
 * top of range falloff ({@link depthChargeControlsGain}).
 *
 * All multipliers are ≥ 1 and step down monotonically close → med → far →
 * outside (baseline 1.0), so this only ever adds gain on top of range falloff
 * and never creates a volume jump as a blast crosses a band boundary. `close`
 * — the band that actually deals damage — boosts hard enough that, combined
 * with near-1 falloff at point-blank range, it clamps at
 * {@link DEPTH_CHARGE_CONTROLS_PEAK_CEILING}: damaging hits sit at the very
 * top of the curve. `med`/`far` add a much smaller boost, so most of the
 * near-vs-far dynamic range comes from the steepened range falloff curve
 * below, not from this multiplier.
 */
export const DEPTH_CHARGE_DAMAGE_BAND_GAIN = {
  close: 1.4,
  med: 1.15,
  far: 1.05,
} as const;

/**
 * Wall-clock window (seconds) over which a multi-charge pattern's one-shots are
 * spread on the client. Server resolve still applies all effects in one turn;
 * audio only is staggered so N blasts are not stacked into a single hit.
 */
export const DEPTH_CHARGE_AUDIO_SPREAD_SEC = 90;

/**
 * Delay (seconds) for the `index`-th of `count` depth-charge one-shots in a
 * simultaneous hear-batch (Controls bridge or hydrophone).
 *
 * - `count <= 1` → 0
 * - else evenly from 0 … {@link DEPTH_CHARGE_AUDIO_SPREAD_SEC}:
 *   `delay = index / (count - 1) * DEPTH_CHARGE_AUDIO_SPREAD_SEC`
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
 * - `t = 1 - range / rMax`, factor = `t⁹` inside the sim damage/stun bands
 *   (range ≤ {@link DEPTH_CHARGE_RANGE_FAR_M}) — unchanged from the prior
 *   pass so close-range and damage-band peaks never move here.
 * - Past the far damage band, an extra `(t / tFar)⁵` taper is layered on top
 *   (continuous at the band edge — no jump), for an effective `t¹⁴` falloff.
 *   The damage bands are a small fraction of the audible radius, so most of
 *   the range beyond them was still reading unnecessarily audible; the extra
 *   taper pushes that non-damaging long-range tail down toward silence much
 *   faster without touching the near/damage-band shape or peak.
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
  // t⁹ — steeper than the prior quintic so quiets are much quieter while
  // near-point-blank stays at/near peak. Left as-is through the far damage
  // band so close/damage-band peaks are unaffected by the extra taper below.
  const t3 = t * t * t;
  const nonuple = t3 * t3 * t3;
  if (r <= DEPTH_CHARGE_RANGE_FAR_NM) return nonuple;

  // Beyond the far damage/stun band: layer on a further taper so the
  // acoustically-audible-but-harmless long-range tail drops toward silence
  // much faster, widening the overall dynamic range. `tFar` is `t` evaluated
  // at the band edge, so `extra` is exactly 1 there (continuous — no jump in
  // the middle of the curve) and shrinks toward 0 as range approaches rMax.
  const tFar = 1 - DEPTH_CHARGE_RANGE_FAR_NM / rMax;
  const extra = t / tFar;
  const extra2 = extra * extra;
  return nonuple * extra2 * extra2 * extra;
}

/**
 * Damage / stun band multiplier from horizontal range to the blast (own ship).
 * 1.0 (baseline — pure quintic range falloff) outside
 * {@link DEPTH_CHARGE_RANGE_FAR_M}; stepped {@link DEPTH_CHARGE_DAMAGE_BAND_GAIN}
 * inside close/med/far, boosting the damage-dealing close band up toward the
 * ceiling and pulling the harmless-but-audible med/far near-miss bands down.
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
 * {@link DEPTH_CHARGE_CONTROLS_PEAK_CEILING} (1.0). A close, damage-dealing
 * charge lands at/near the ceiling; med/far near-misses and long-range blasts
 * fall well below it, for a dramatic near-vs-far dynamic range.
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
