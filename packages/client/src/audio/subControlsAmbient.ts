/**
 * Depth-banded ambient loops for submarine Controls.
 * Destroyer Controls keep {@link CONTROLS_AMBIENT_SAMPLE_URL} (facility hum).
 */

/** Default / shallow keel (depth &lt; {@link SUB_AMBIENT_DEEP_MIN_M}). */
export const SUB_AMBIENT_SHALLOW_URL = '/audio/sub-ambience-shallow-exposition.ogg';

/** Mid band: {@link SUB_AMBIENT_DEEP_MIN_M}–{@link SUB_AMBIENT_DEEP_MAX_M} m (gap to crush stays mid). */
export const SUB_AMBIENT_DEEP_URL = '/audio/sub-ambience-deep-dive.ogg';

/** Crush band: ≥ {@link SUB_AMBIENT_CRUSH_MIN_M} m (through {@link SUB_AMBIENT_CRUSH_MAX_M}+). */
export const SUB_AMBIENT_CRUSH_URL = '/audio/sub-ambience-crush-creaking.ogg';

/** Inclusive lower bound for the mid / “deep dive” loop (m). */
export const SUB_AMBIENT_DEEP_MIN_M = 90;

/**
 * Documented upper bound for the mid band (m). Keel past this but still below
 * crush keeps the mid loop until {@link SUB_AMBIENT_CRUSH_MIN_M}.
 */
export const SUB_AMBIENT_DEEP_MAX_M = 140;

/** Inclusive lower bound for the crush / heavy-creaking loop (m). */
export const SUB_AMBIENT_CRUSH_MIN_M = 150;

/**
 * Documented upper bound for the crush band (m). Past this (max ordered depth)
 * the crush loop continues — no fourth bed.
 */
export const SUB_AMBIENT_CRUSH_MAX_M = 180;

/**
 * Default bed gain for mid + crush bands — match destroyer facility-hum
 * presence under combat one-shots.
 */
export const SUB_CONTROLS_AMBIENT_GAIN = 0.22;

/**
 * Shallow / exposition loop (&lt; 90 m) — louder than mid/crush so the quieter
 * exposition bed reads clearly on Controls speakers.
 */
export const SUB_AMBIENT_SHALLOW_GAIN = 0.40;

/** Crossfade when the keel crosses a band boundary (seconds). */
export const SUB_AMBIENT_CROSSFADE_SEC = 1.0;

export type SubAmbientBand = 'shallow' | 'deep' | 'crush';

export const SUB_AMBIENT_URL_BY_BAND: Record<SubAmbientBand, string> = {
  shallow: SUB_AMBIENT_SHALLOW_URL,
  deep: SUB_AMBIENT_DEEP_URL,
  crush: SUB_AMBIENT_CRUSH_URL,
};

/** Peak gain for each ambient band (shallow raised; deep/crush keep baseline). */
export const SUB_AMBIENT_GAIN_BY_BAND: Record<SubAmbientBand, number> = {
  shallow: SUB_AMBIENT_SHALLOW_GAIN,
  deep: SUB_CONTROLS_AMBIENT_GAIN,
  crush: SUB_CONTROLS_AMBIENT_GAIN,
};

export function subAmbientGainForBand(band: SubAmbientBand): number {
  return SUB_AMBIENT_GAIN_BY_BAND[band];
}

/**
 * Map keel depth (m, positive-down) → ambient band.
 * Controls ambiance should pass the Dive DEPTH needle (tweened displayed
 * depth), not resolve-jump sim keel, so the bed switches when the needle
 * crosses the threshold.
 *
 * - `&lt; 90` → shallow (default / surface / patrol)
 * - `90 … &lt; 150` → deep (covers documented 90–140 plus the 141–149 gap)
 * - `≥ 150` → crush (150–180 and past-crush)
 */
export function subAmbientBandForDepth(depthM: number): SubAmbientBand {
  const d = Math.max(0, depthM);
  if (d >= SUB_AMBIENT_CRUSH_MIN_M) return 'crush';
  if (d >= SUB_AMBIENT_DEEP_MIN_M) return 'deep';
  return 'shallow';
}

export async function loadSubAmbientBuffer(
  ctx: AudioContext,
  band: SubAmbientBand,
): Promise<AudioBuffer> {
  const url = SUB_AMBIENT_URL_BY_BAND[band];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sub ambient ${band} fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type AmbientLoopVoice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
};

/**
 * Start (or crossfade to) a looping ambient bed.
 * When `prev` is set, fades it out over `fadeSec` and stops it after the ramp.
 */
export function crossfadeAmbientLoop(
  ctx: AudioContext,
  nextBuffer: AudioBuffer,
  destination: AudioNode,
  prev: AmbientLoopVoice | null,
  peakGain: number = SUB_CONTROLS_AMBIENT_GAIN,
  fadeSec: number = SUB_AMBIENT_CROSSFADE_SEC,
): AmbientLoopVoice {
  const now = ctx.currentTime;
  const fade = Math.max(0.01, fadeSec);
  const nextGain = ctx.createGain();
  const nextSource = ctx.createBufferSource();
  nextSource.buffer = nextBuffer;
  nextSource.loop = true;
  nextSource.connect(nextGain);
  nextGain.connect(destination);

  if (prev) {
    nextGain.gain.setValueAtTime(0, now);
    nextGain.gain.linearRampToValueAtTime(peakGain, now + fade);
    const oldGainParam = prev.gain.gain;
    oldGainParam.cancelScheduledValues(now);
    oldGainParam.setValueAtTime(oldGainParam.value, now);
    oldGainParam.linearRampToValueAtTime(0, now + fade);
    const oldSource = prev.source;
    const oldGain = prev.gain;
    window.setTimeout(() => {
      try {
        oldSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        oldSource.disconnect();
        oldGain.disconnect();
      } catch {
        /* ignore */
      }
    }, (fade + 0.08) * 1000);
  } else {
    // First start: short fade-in so unlock is not a hard edge.
    nextGain.gain.setValueAtTime(0, now);
    nextGain.gain.linearRampToValueAtTime(peakGain, now + Math.min(0.35, fade));
  }

  nextSource.start(0);
  return { source: nextSource, gain: nextGain };
}

/** Hard-stop an ambient voice (leave / teardown). */
export function stopAmbientLoopVoice(voice: AmbientLoopVoice | null): void {
  if (!voice) return;
  try {
    voice.source.stop();
  } catch {
    /* already stopped */
  }
  try {
    voice.source.disconnect();
    voice.gain.disconnect();
  } catch {
    /* ignore */
  }
}
