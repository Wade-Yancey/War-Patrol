/** Torpedo-hit explosion sample (Controls bridge — firer + target). */
export const TORPEDO_HIT_SAMPLE_URL = '/audio/explosion.wav';

/**
 * Peak gain on Controls at zero range (before distance attenuation).
 * Dialed back from 0.82 — the blast was dominating the bridge mix; still a
 * clear, audible hit cue, just no longer overpowering.
 */
export const TORPEDO_HIT_CONTROLS_PEAK_GAIN = 0.55;

/**
 * Wall-clock gap (seconds) between explosion onsets when several torpedoes
 * share the same presentation delay (same resolve moment). Keeps relative
 * turn-arrival timing; only same-moment stacks are split so museum crews can
 * count distinct bangs. Singles and uniquely-timed hits stay unchanged.
 * 250 ms sits mid 150–400 ms — countable without dragging a multi-fish salvo.
 */
export const TORPEDO_HIT_SAME_MOMENT_STAGGER_SEC = 0.25;

export async function loadTorpedoHitBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(TORPEDO_HIT_SAMPLE_URL);
  if (!res.ok) throw new Error(`Torpedo-hit sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayTorpedoHitOptions = {
  /** Seconds from `ctx.currentTime` before the one-shot starts (default 0). */
  whenSec?: number;
};

/**
 * Map each torpedo-hit cue id → playback / Damage-reveal `whenSec`.
 *
 * Base delay is `audioDelaySec` (compressed turn-relative presentation). Hits
 * that share the same base delay (rounded to 1 ms) get
 * `+ index * {@link TORPEDO_HIT_SAME_MOMENT_STAGGER_SEC}` within that group.
 * Physics / resolve are unchanged — audio scheduling only.
 */
export function torpedoHitBatchWhenSecById(
  events: ReadonlyArray<{ id: string; audioDelaySec?: number }>,
): Map<string, number> {
  const sorted = events.slice().sort((a, b) => {
    const da = Math.max(0, a.audioDelaySec ?? 0);
    const db = Math.max(0, b.audioDelaySec ?? 0);
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
  const out = new Map<string, number>();
  let groupKeyMs = Number.NaN;
  let groupIndex = 0;
  for (const e of sorted) {
    const base = Math.max(0, e.audioDelaySec ?? 0);
    const keyMs = Math.round(base * 1000);
    if (keyMs !== groupKeyMs) {
      groupKeyMs = keyMs;
      groupIndex = 0;
    }
    out.set(e.id, base + groupIndex * TORPEDO_HIT_SAME_MOMENT_STAGGER_SEC);
    groupIndex += 1;
  }
  return out;
}

/** One-shot playback of the explosion sample into `destination`. */
export function playTorpedoHitSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayTorpedoHitOptions = {},
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
