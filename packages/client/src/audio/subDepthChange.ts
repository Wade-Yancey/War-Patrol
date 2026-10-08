/** Underwater depth-change one-shot for submarine keel motion (Controls). */
export const SUB_DEPTH_CHANGE_SAMPLE_URL = '/audio/sub-depth-change.wav';

/**
 * Peak gain for own-ship depth-change SFX on the submarine Controls station.
 * Loud enough for BT speakers after a resolve dive/ascent; below tube-door /
 * deck-gun peaks (0.7) so stacked bridge cues do not clip.
 */
export const SUB_DEPTH_CHANGE_PEAK_GAIN = 0.6;

/**
 * Minimum keel delta (m) to count as a meaningful depth change on resolve.
 * Ignores float noise; well below one dive-rate step.
 */
export const SUB_DEPTH_CHANGE_MIN_DELTA_M = 0.5;

/** Snapshot used by Controls to decide whether to fire the depth-change bed. */
export type SubDepthChangeSfxSnapshot = {
  unitId: string;
  depth: number;
  orderedDepth: number;
  turn: number;
  /**
   * Ordered depth we last played the rush cue for. Suppresses re-triggers on
   * later resolves that are still chasing the same set-point.
   */
  playedForOrderedDepth: number | null;
};

/**
 * True when the water-rushing bed should play on this observation.
 *
 * Requires a turn advance and a meaningful keel delta, and only once per
 * ordered-depth set-point (not every submerged transit resolve). Being
 * submerged alone never qualifies.
 */
export function shouldPlaySubDepthChangeSfx(
  prev: SubDepthChangeSfxSnapshot,
  next: Pick<SubDepthChangeSfxSnapshot, 'unitId' | 'depth' | 'orderedDepth' | 'turn'>,
): boolean {
  if (next.unitId !== prev.unitId) return false;
  if (!(next.turn > prev.turn)) return false;
  if (!(Math.abs(next.depth - prev.depth) >= SUB_DEPTH_CHANGE_MIN_DELTA_M)) return false;
  if (prev.playedForOrderedDepth === null) return true;
  return Math.abs(next.orderedDepth - prev.playedForOrderedDepth) >= SUB_DEPTH_CHANGE_MIN_DELTA_M;
}

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

export type PlaySubDepthChangeOptions = {
  /** Override peak gain (e.g. ducked under Emergency Blow venting). */
  peakGain?: number;
};

/**
 * One-shot underwater cue when the sub applies a new ordered depth on resolve.
 * Stops any prior play so a fresh order can replace an in-flight clip.
 * Failures (autoplay block, missing sample) are swallowed — UI must stay usable.
 */
export async function playSubDepthChange(options: PlaySubDepthChangeOptions = {}): Promise<void> {
  try {
    const { ctx, buffer } = await ensureDepthChange();
    const peak =
      options.peakGain !== undefined ? options.peakGain : SUB_DEPTH_CHANGE_PEAK_GAIN;
    if (peak < 0.001) return;
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
    gain.gain.value = peak;
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
