/** Emergency-blow ballast venting one-shot for submarine Controls. */
export const EMERGENCY_BLOW_VENTING_SAMPLE_URL = '/audio/emergency-blow-venting.wav';

/**
 * Peak gain for the venting cue on submarine Controls.
 * Prominent speaker ambience under stacked depth-change (0.6) / deck-gun (0.7).
 */
export const EMERGENCY_BLOW_VENTING_PEAK_GAIN = 0.5;

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

async function ensureVenting(): Promise<{ ctx: AudioContext; buffer: AudioBuffer }> {
  const Ctx = audioContextCtor();
  if (!sharedCtx) sharedCtx = new Ctx();
  if (sharedCtx.state === 'suspended') {
    await sharedCtx.resume();
  }
  if (!sharedBuffer) {
    if (!loadPromise) {
      loadPromise = (async () => {
        const res = await fetch(EMERGENCY_BLOW_VENTING_SAMPLE_URL);
        if (!res.ok) throw new Error(`Emergency-blow venting sample fetch ${res.status}`);
        const raw = await res.arrayBuffer();
        return sharedCtx!.decodeAudioData(raw.slice(0));
      })();
    }
    sharedBuffer = await loadPromise;
  }
  return { ctx: sharedCtx, buffer: sharedBuffer };
}

/**
 * One-shot ballast-vent cue when an emergency blow ascent is processed on resolve.
 * Stops any prior play so multi-turn ascents replace rather than stack the clip.
 * Failures (autoplay block, missing sample) are swallowed — UI must stay usable.
 */
export async function playEmergencyBlowVenting(): Promise<void> {
  try {
    const { ctx, buffer } = await ensureVenting();
    if (EMERGENCY_BLOW_VENTING_PEAK_GAIN < 0.001) return;
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
    gain.gain.value = EMERGENCY_BLOW_VENTING_PEAK_GAIN;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      if (activeSource === source) activeSource = null;
    };
    activeSource = source;
    source.start();
  } catch {
    // Ignore unlock / network / decode errors for optional bridge SFX.
  }
}
