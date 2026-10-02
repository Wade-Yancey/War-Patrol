/** Engine-order telegraph single-ring bell (local console — EOT change). */
export const ENGINE_ORDER_BELL_SAMPLE_URL = '/audio/engine-order-bell.wav';

/** Peak gain for the telegraph ding on station / umpire EOT UI. */
export const ENGINE_ORDER_BELL_PEAK_GAIN = 0.45;

let sharedCtx: AudioContext | null = null;
let sharedBuffer: AudioBuffer | null = null;
let loadPromise: Promise<AudioBuffer> | null = null;

function audioContextCtor(): typeof AudioContext {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

async function ensureBell(): Promise<{ ctx: AudioContext; buffer: AudioBuffer }> {
  const Ctx = audioContextCtor();
  if (!sharedCtx) sharedCtx = new Ctx();
  if (sharedCtx.state === 'suspended') {
    await sharedCtx.resume();
  }
  if (!sharedBuffer) {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await fetch(ENGINE_ORDER_BELL_SAMPLE_URL);
        if (!res.ok) throw new Error(`Engine-order bell sample fetch ${res.status}`);
        const raw = await res.arrayBuffer();
        return sharedCtx!.decodeAudioData(raw.slice(0));
      })();
    }
    sharedBuffer = await loadPromise;
  }
  return { ctx: sharedCtx, buffer: sharedBuffer };
}

/**
 * One-shot telegraph ding for a real EOT setting change.
 * Failures (autoplay block, missing sample) are swallowed — UI must stay usable.
 */
export async function playEngineOrderBell(): Promise<void> {
  try {
    const { ctx, buffer } = await ensureBell();
    if (ENGINE_ORDER_BELL_PEAK_GAIN < 0.001) return;
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = ENGINE_ORDER_BELL_PEAK_GAIN;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  } catch {
    // Ignore unlock / network / decode errors for optional UI SFX.
  }
}
