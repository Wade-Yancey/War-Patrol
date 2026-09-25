import {
  bearingRangeNm,
  canUseSensorStation,
  DEPTH_CHARGE_HYDROPHONE_RANGE_NM,
  findHydrophoneSensor,
  isActiveSonarPinging,
  isHydrophoneDepthOk,
  isHydrophoneEmitter,
  resolveHydrophoneMaxRangeNm,
  type GameSave,
  type HydrophoneContact,
  type UnitState,
} from '@war-patrol/shared';

export type HydrophonePicture = {
  contacts: HydrophoneContact[];
  maxRangeNm: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'surfaced';
};

/**
 * Server-authoritative hydrophone cues (audio only).
 *
 * Propeller contacts: underway waterborne hulls.
 * Active-sonar pings: destroyers with search sonar toggled ON.
 * Depth-charge detonations: recent explosions within hearing range (one-shot WAV).
 *
 * Fleet-sub hydrophone is submerged-only (depth > 5 m).
 */
export function buildHydrophoneContacts(own: UnitState, save: GameSave): HydrophonePicture {
  const sensor = findHydrophoneSensor(own);
  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = resolveHydrophoneMaxRangeNm(sensor);

  const sensorOk = canUseSensorStation(own, 'hydrophone');
  if (!sensorOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: sensorOk.reason,
    };
  }

  const depthOk = isHydrophoneDepthOk(own);
  if (!depthOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: depthOk.reason,
    };
  }

  const contacts: HydrophoneContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    // Hydrophone is underwater listen — skip aircraft (fighters/bombers airborne).
    if (other.type === 'Aircraft') continue;

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

    const roundedBearing = Math.round(bearing * 10) / 10;
    const roundedRange = Math.round(rangeNm * 100) / 100;

    if (isHydrophoneEmitter(other)) {
      contacts.push({
        id: `h-${hashTrackId(own.id, other.id, 'prop')}`,
        bearing: roundedBearing,
        rangeNm: roundedRange,
        kind: 'propeller',
      });
    }

    if (isActiveSonarPinging(other)) {
      contacts.push({
        id: `h-${hashTrackId(own.id, other.id, 'ping')}`,
        bearing: roundedBearing,
        rangeNm: roundedRange,
        kind: 'active_sonar_ping',
      });
    }
  }

  // Recent depth-charge / aircraft-bomb detonations (acoustic events — not continuous
  // emitters). Aircraft themselves stay hydrophone-blind; bomb blasts in the water are not.
  // Range from *this* listening hull to the blast — never filtered by who dropped.
  const dcMax = Math.min(maxRangeNm, DEPTH_CHARGE_HYDROPHONE_RANGE_NM);
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

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, operational: true };
}

function hashTrackId(ownId: string, otherId: string, salt: string): string {
  let h = 2166136261;
  const s = `${ownId}|${otherId}|hydro|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
