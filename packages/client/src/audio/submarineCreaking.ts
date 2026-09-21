import {
  FLEET_SUB_CRUSH_DEPTH_M,
  FLEET_SUB_TEST_DEPTH_M,
  RADAR_SURFACE_DEPTH_M,
} from '@war-patrol/shared';

/** Hull-pressure creak for submerged submarine Controls (BT speakers). */
export const SUBMARINE_CREAKING_SAMPLE_URL = '/audio/submarine-creaking.wav';

/** Quiet ambient one-shot — sits under the facility hum, below DC/torpedo peaks. */
export const SUBMARINE_CREAK_AMBIENT_GAIN = 0.14;

/** Louder burst when a nearby depth charge hits while submerged. */
export const SUBMARINE_CREAK_DC_GAIN = 0.28;

/** Mean seconds between ambient creaks just below the surface band. */
export const SUBMARINE_CREAK_INTERVAL_SHALLOW_SEC = 48;

/** Mean seconds between ambient creaks at {@link FLEET_SUB_TEST_DEPTH_M}. */
export const SUBMARINE_CREAK_INTERVAL_AT_TEST_SEC = 10;

/**
 * Mean seconds at crush depth — hull under extreme pressure.
 * Steep power curve from test→crush drives interval down hard near this floor.
 */
export const SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC = 2;

/** Past crush: near-continuous ambient creaking. */
export const SUBMARINE_CREAK_INTERVAL_PAST_CRUSH_SEC = 1.2;

/** @deprecated Prefer {@link SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC}. */
export const SUBMARINE_CREAK_INTERVAL_DEEP_SEC = SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC;

/** Play this many seconds of the sample per ambient creak (random offset). */
export const SUBMARINE_CREAK_AMBIENT_DURATION_SEC = 3.2;

/** Slightly longer window for a DC stress burst. */
export const SUBMARINE_CREAK_DC_DURATION_SEC = 4.5;

/**
 * Mean interval (ms) between ambient creaks for keel depth.
 * - Surfaced (≤ {@link RADAR_SURFACE_DEPTH_M}): no ambient creaks (Infinity).
 * - Surface band → test: linear 48 s → 10 s.
 * - Test → crush: **t³** blend 10 s → 2 s (stays quieter until near crush, then spikes).
 * - Past crush: 1.2 s mean (super frequent).
 * DC stress creaks remain separate (one per nearby Controls blast).
 */
export function creakIntervalMsForDepth(depthM: number): number {
  if (!(depthM > RADAR_SURFACE_DEPTH_M)) return Number.POSITIVE_INFINITY;

  if (depthM > FLEET_SUB_CRUSH_DEPTH_M) {
    return SUBMARINE_CREAK_INTERVAL_PAST_CRUSH_SEC * 1000;
  }

  if (depthM <= FLEET_SUB_TEST_DEPTH_M) {
    const span = Math.max(1, FLEET_SUB_TEST_DEPTH_M - RADAR_SURFACE_DEPTH_M);
    const t = Math.min(1, Math.max(0, (depthM - RADAR_SURFACE_DEPTH_M) / span));
    const sec =
      SUBMARINE_CREAK_INTERVAL_SHALLOW_SEC +
      (SUBMARINE_CREAK_INTERVAL_AT_TEST_SEC - SUBMARINE_CREAK_INTERVAL_SHALLOW_SEC) * t;
    return sec * 1000;
  }

  // Steep near crush: cubic ease so creaks become super frequent only close to the line.
  const span = Math.max(1, FLEET_SUB_CRUSH_DEPTH_M - FLEET_SUB_TEST_DEPTH_M);
  const t = Math.min(1, Math.max(0, (depthM - FLEET_SUB_TEST_DEPTH_M) / span));
  const steep = t * t * t;
  const sec =
    SUBMARINE_CREAK_INTERVAL_AT_TEST_SEC +
    (SUBMARINE_CREAK_INTERVAL_AT_CRUSH_SEC - SUBMARINE_CREAK_INTERVAL_AT_TEST_SEC) * steep;
  return sec * 1000;
}

/** Jitter so ambient creaks are not metronomic (±30%). */
export function jitterCreakIntervalMs(meanMs: number): number {
  if (!Number.isFinite(meanMs) || meanMs <= 0) return meanMs;
  const factor = 0.7 + Math.random() * 0.6;
  return meanMs * factor;
}

export async function loadSubmarineCreakingBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(SUBMARINE_CREAKING_SAMPLE_URL);
  if (!res.ok) throw new Error(`Submarine creaking sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

export type PlayCreakOptions = {
  /** Offset into the buffer (sec). Random when omitted. */
  offsetSec?: number;
  /** How long to play (sec). Clamped to remaining buffer. */
  durationSec?: number;
  /** Seconds from `ctx.currentTime` before the creak starts (default 0). */
  whenSec?: number;
};

/**
 * One-shot creak into `destination`. Picks a random window in a long sample
 * so repeated plays do not sound identical.
 */
export function playSubmarineCreakSample(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  peakGain: number,
  options: PlayCreakOptions = {},
): AudioBufferSourceNode | null {
  if (peakGain < 0.001 || buffer.duration < 0.05) return null;
  const durationSec = Math.min(
    options.durationSec ?? SUBMARINE_CREAK_AMBIENT_DURATION_SEC,
    buffer.duration,
  );
  const maxOffset = Math.max(0, buffer.duration - durationSec);
  const offsetSec =
    options.offsetSec != null
      ? Math.min(Math.max(0, options.offsetSec), maxOffset)
      : maxOffset > 0
        ? Math.random() * maxOffset
        : 0;
  const whenSec = Math.max(0, options.whenSec ?? 0);

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = peakGain;
  source.connect(gain);
  gain.connect(destination);
  source.start(ctx.currentTime + whenSec, offsetSec, durationSec);
  return source;
}
