import {
  bearingRangeNm,
  canUseSensors,
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
 * Active-sonar pings: destroyers (or other units) with search sonar toggled ON —
 * audible through the same range × beam model when the listener trains the needle.
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

  const sensorOk = canUseSensors(own);
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
