/** Underwater depth-change one-shot for submarine dive orders (Controls). */
export const SUB_DEPTH_CHANGE_SAMPLE_URL = '/audio/sub-depth-change.wav';

/**
 * Peak gain for own-ship depth-order SFX on the submarine station.
 * Below short telegraph dings; above quiet ambient creaks / facility hum.
 */
export const SUB_DEPTH_CHANGE_PEAK_GAIN = 0.32;

let sharedCtx: AudioContext | null = null;
let sharedBuffer: AudioBuffer | null = null;
let loadPromise: Promise<AudioBuffer> | null = null;
let activeSource: AudioBufferSourceNode | null = null;

function audioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

async function ensureDepthChange(): Promise<{ ctx: AudioContext; buffer: AudioBuffer }> {
  const Ctx = audioContextCtor();
  if (!sharedCtx) sharedCtx = new Ctx();
  if (sharedCtx.state === 'suspended') {
    await sharedCtx.resume();
  }
  if (!sharedBuffer) {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await fetch(SUB_DEPTH_CHANGE_SAMPLE_URL);
        if (!res.ok) throw new Error(`Sub depth-change sample fetch ${res.status}`);
        const raw = await res.arrayBuffer();
        return sharedCtx!.decodeAudioData(raw.slice(0));
      })();
    }
    sharedBuffer = await loadPromise;
  }
  return { ctx: sharedCtx, buffer: sharedBuffer };
}

/**
 * One-shot underwater cue when the sub's ordered depth changes.
 * Stops any prior play so rapid re-orders do not stack the long clip.
 * Failures (autoplay block, missing sample) are swallowed — UI must stay usable.
 */
export async function playSubDepthChange(): Promise<void> {
  try {
    const { ctx, buffer } = await ensureDepthChange();
    if (SUB_DEPTH_CHANGE_PEAK_GAIN < 0.001) return;
    if (activeSource) {
      try {
        activeSource.stop();
      } catch {
        // Already ended.
      }
      activeSource = null;
    }
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = SUB_DEPTH_CHANGE_PEAK_GAIN;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      if (activeSource === source) activeSource = null;
    };
    activeSource = source;
    source.start();
  } catch {
    // Ignore unlock / network / decode errors for optional UI SFX.
  }
}
