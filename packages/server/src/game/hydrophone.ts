import {
  activeNoisemakers,
  bearingRangeNm,
  canUseSensorStation,
  DEPTH_CHARGE_HYDROPHONE_RANGE_NM,
  findHydrophoneSensor,
  hydrophoneEffectiveMaxRangeNm,
  hydrophoneListenQuality,
  hydrophoneRadiatedSourceLevel,
  hydrophoneSelfNoise,
  HYDROPHONE_RELOAD_RANGE_NM,
  HYDROPHONE_RELOAD_SOURCE_LEVEL,
  HYDROPHONE_SINK_RANGE_NM,
  isActiveSonarPinging,
  isHydrophoneDepthOk,
  isHydrophoneEmitter,
  isHydrophoneReloadCueLive,
  noisemakerSourceLevel,
  resolveHydrophoneMaxRangeNm,
  type GameSave,
  type HydrophoneContact,
  type UnitState,
} from '@war-patrol/shared';
import { opaqueTrackId } from './opaqueTrackId.js';

export type HydrophonePicture = {
  contacts: HydrophoneContact[];
  maxRangeNm: number;
  /** Configured max after self-noise shrinkage. */
  effectiveRangeNm: number;
  /** Own-ship listen quality 0–1 (1 = best). */
  listenQuality: number;
  /** Own-ship self-noise 0–1. */
  selfNoise: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'surfaced';
};

/**
 * Server-authoritative hydrophone cues (audio only).
 *
 * Propeller contacts: underway waterborne hulls with speed/depth radiated level
 *   (EOT STOP → no propeller contact, even with residual way-on).
 * Active-sonar pings: destroyers with search sonar toggled ON.
 * Depth-charge detonations: recent explosions within hearing range (one-shot WAV).
 * Torpedo reload: mechanical spike when a sub starts tube reload (FoW intensity) —
 *   not gated by {@link isHydrophoneEmitter}; STOP boats still clank.
 * Vessel sunk: recent `unit_sunk` / `hull_implosion` combat-log lines within
 *   hearing range (one-shot aftermath WAV) — waterborne hulls only.
 *
 * Own-ship self-noise from speed shrinks effective range and listen quality.
 * Fleet-sub hydrophone is submerged-only (depth > 5 m); DD hydro is always depth-ok.
 */
export function buildHydrophoneContacts(own: UnitState, save: GameSave): HydrophonePicture {
  const sensor = findHydrophoneSensor(own);
  const selfNoise = hydrophoneSelfNoise(own);
  const listenQuality = hydrophoneListenQuality(own);

  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      effectiveRangeNm: 0,
      listenQuality,
      selfNoise,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = resolveHydrophoneMaxRangeNm(sensor);
  const effectiveRangeNm = hydrophoneEffectiveMaxRangeNm(maxRangeNm, listenQuality);

  const sensorOk = canUseSensorStation(own, 'hydrophone');
  if (!sensorOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      effectiveRangeNm,
      listenQuality,
      selfNoise,
      operational: false,
      unavailableReason: sensorOk.reason,
    };
  }

  const depthOk = isHydrophoneDepthOk(own);
  if (!depthOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      effectiveRangeNm,
      listenQuality,
      selfNoise,
      operational: false,
      unavailableReason: depthOk.reason,
    };
  }

  const contacts: HydrophoneContact[] = [];
  const turnNumber = save.turn.number;

  for (const other of save.units) {
    if (other.id === own.id) continue;
    // Hydrophone is underwater listen — skip aircraft (fighters/bombers airborne).
    if (other.type === 'Aircraft') continue;

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm <= 0) continue;

    const roundedBearing = Math.round(bearing * 10) / 10;
    const roundedRange = Math.round(rangeNm * 100) / 100;

    if (isHydrophoneEmitter(other) && rangeNm <= effectiveRangeNm) {
      const level = hydrophoneRadiatedSourceLevel(other);
      if (level > 0.02) {
        contacts.push({
          id: `h-${opaqueTrackId([own.id, other.id, 'hydro', 'prop'])}`,
          bearing: roundedBearing,
          rangeNm: roundedRange,
          kind: 'propeller',
          sourceLevel: Math.round(level * 100) / 100,
        });
      }
    }

    // Active sonar pings cut through self-noise better — use configured max.
    if (isActiveSonarPinging(other) && rangeNm <= maxRangeNm) {
      contacts.push({
        id: `h-${opaqueTrackId([own.id, other.id, 'hydro', 'ping'])}`,
        bearing: roundedBearing,
        rangeNm: roundedRange,
        kind: 'active_sonar_ping',
      });
    }

    // Torpedo-room reload mechanical spike (no GT identity).
    // Independent of screw emission — EOT STOP silences propellers only; reload
    // clanks remain hearable while the acoustic stamp is live. Loud spike cuts
    // through listener self-noise like active-sonar pings (configured max, not
    // effectiveRange), still capped at HYDROPHONE_RELOAD_RANGE_NM.
    if (
      isHydrophoneReloadCueLive(other.torpedoReloadAcousticTurn, turnNumber) &&
      rangeNm <= Math.min(maxRangeNm, HYDROPHONE_RELOAD_RANGE_NM)
    ) {
      contacts.push({
        id: `h-${opaqueTrackId([own.id, other.id, 'hydro', 'reload', String(other.torpedoReloadAcousticTurn)])}`,
        bearing: roundedBearing,
        rangeNm: roundedRange,
        kind: 'torpedo_reload',
        sourceLevel: HYDROPHONE_RELOAD_SOURCE_LEVEL,
      });
    }
  }

  // Recent depth-charge / aircraft-bomb detonations (acoustic events — not continuous
  // emitters). Aircraft themselves stay hydrophone-blind; bomb blasts in the water are not.
  // Range from *this* listening hull to the blast — never filtered by who dropped.
  const dcMax = Math.min(effectiveRangeNm, DEPTH_CHARGE_HYDROPHONE_RANGE_NM);
  for (const det of save.recentDetonations ?? []) {
    if (det.kind !== 'depth_charge' && det.kind !== 'aircraft_bomb') continue;
    if (det.turnNumber < save.turn.number - 1) continue;
    const { bearing, rangeNm } = bearingRangeNm(own.position, det.position);
    if (rangeNm > dcMax || rangeNm <= 0) continue;
    contacts.push({
      id: det.kind === 'aircraft_bomb' ? `h-abomb-${det.id}` : `h-dc-${det.id}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      kind: 'depth_charge',
    });
  }

  // Recent vessel sinks / hull implosions — one-shot aftermath at the wreck position.
  // Same turn window as DC hydro cues (last resolve). Aircraft wrecks stay silent.
  const sinkMax = Math.min(effectiveRangeNm, HYDROPHONE_SINK_RANGE_NM);
  const unitsById = new Map(save.units.map((u) => [u.id, u]));
  for (const entry of save.combatLog ?? []) {
    if (entry.kind !== 'unit_sunk' && entry.kind !== 'hull_implosion') continue;
    if (entry.turnNumber < save.turn.number - 1) continue;
    const targetId = entry.targetUnitId;
    if (!targetId || targetId === own.id) continue;
    const wreck = unitsById.get(targetId);
    if (!wreck || wreck.type === 'Aircraft') continue;
    const { bearing, rangeNm } = bearingRangeNm(own.position, wreck.position);
    if (rangeNm > sinkMax || rangeNm <= 0) continue;
    contacts.push({
      id: `h-sink-${entry.id}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      kind: 'vessel_sunk',
    });
  }

  // Drifting noisemaker decoys — loud continuous emitters. FoW paints them as
  // propeller contacts (no decoy identity leak); sourceLevel makes them compete
  // with underway hulls on the listen needle. Hydro cues stay audio-only (no course).
  const nmLevel = noisemakerSourceLevel();
  for (const nm of activeNoisemakers(save.noisemakers)) {
    const { bearing, rangeNm } = bearingRangeNm(own.position, nm.position);
    if (rangeNm > effectiveRangeNm || rangeNm <= 0) continue;
    contacts.push({
      id: `h-${opaqueTrackId([own.id, nm.id, 'hydro', 'nmkr'])}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      kind: 'propeller',
      sourceLevel: nmLevel,
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return {
    contacts,
    maxRangeNm,
    effectiveRangeNm,
    listenQuality,
    selfNoise,
    operational: true,
  };
}
