/**
 * Own-ship sunk farewell — “It's a Long, Long Way to Tipperary” (1915).
 * Controls sunk modal only; Sensors stay silent. Stop via the modal control.
 */
export const TIPPERARY_SUNK_SAMPLE_URL = '/audio/long-way-to-tipperary.ogg';

/**
 * Peak gain under remaining Controls beds (~0.22–0.40 ambient).
 * A notch above the prior 0.32 farewell so the disc reads clearly without
 * clipping over the ambient bed.
 */
export const TIPPERARY_SUNK_PEAK_GAIN = 0.40;

/** Soft rise so the disc doesn’t slam in over residual ambience. */
export const TIPPERARY_SUNK_FADE_IN_SEC = 0.6;

export type TipperaryPlayback = {
  ctx: AudioContext;
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Fade out (~120 ms) then disconnect. Safe to call more than once. */
  stop: () => void;
};

export async function loadTipperarySunkBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(TIPPERARY_SUNK_SAMPLE_URL);
  if (!res.ok) throw new Error(`Tipperary sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayTipperaryOptions = {
  peakGain?: number;
  /** Fires when the buffer ends naturally (not after an explicit stop). */
  onEnded?: () => void;
};

/**
 * Start Tipperary into the destination (usually `ctx.destination`).
 * Returns a handle whose `stop()` fades out quickly and disconnects.
 */
export function playTipperarySunk(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  options: PlayTipperaryOptions = {},
): TipperaryPlayback {
  const peakGain = options.peakGain ?? TIPPERARY_SUNK_PEAK_GAIN;
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  source.loop = false;
  const now = ctx.currentTime;
  const fade = Math.max(0.01, TIPPERARY_SUNK_FADE_IN_SEC);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(Math.max(0, peakGain), now + fade);
  source.connect(gain);
  gain.connect(destination);
  source.start(now);

  let stopped = false;
  const disconnect = () => {
    try {
      source.disconnect();
      gain.disconnect();
    } catch {
      /* ignore */
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    const t = ctx.currentTime;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.12);
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      disconnect();
    }, 140);
  };

  source.onended = () => {
    if (stopped) return;
    stopped = true;
    disconnect();
    options.onEnded?.();
  };

  return { ctx, source, gain, stop };
}
