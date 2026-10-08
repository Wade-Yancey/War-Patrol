import { FLEET_SUB_CRUSH_DEPTH_M } from '@war-patrol/shared';

/**
 * Dramatic underwater metal clanking loop for deep submarine Controls.
 * Replaces ambient hull-creak one-shots at crush depth and deeper.
 */
export const DEEP_HULL_CLANKING_SAMPLE_URL = '/audio/deep-hull-clanking.ogg';

/**
 * Keel depth (m) at/above which the deep clank loop replaces ambient creaks.
 * Matches {@link FLEET_SUB_CRUSH_DEPTH_M} (150 m).
 */
export const DEEP_HULL_CLANKING_DEPTH_M = FLEET_SUB_CRUSH_DEPTH_M;

/**
 * Loop bed gain on Controls — suspenseful but under DC/torpedo peaks
 * and comparable to ambient creak presence when sustained.
 */
export const DEEP_HULL_CLANKING_GAIN = 0.26;

export function isDeepHullClankingDepth(depthM: number): boolean {
  return depthM >= DEEP_HULL_CLANKING_DEPTH_M;
}

export async function loadDeepHullClankingBuffer(ctx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch(DEEP_HULL_CLANKING_SAMPLE_URL);
  if (!res.ok) throw new Error(`Deep hull clanking sample fetch ${res.status}`);
  const raw = await res.arrayBuffer();
  return ctx.decodeAudioData(raw.slice(0));
}

/**
 * Start a seamless loop of the deep clank sample into `destination`.
 * Caller must stop/disconnect the returned source on teardown / ascent.
 */
export function startDeepHullClankingLoop(
  ctx: AudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  gainValue: number = DEEP_HULL_CLANKING_GAIN,
): { source: AudioBufferSourceNode; gain: GainNode } {
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(gain);
  gain.connect(destination);
  source.start(0);
  return { source, gain };
}
