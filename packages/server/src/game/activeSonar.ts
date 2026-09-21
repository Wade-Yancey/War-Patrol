import {
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  canUseSensors,
  defaultRadarSignature,
  ensureContactLabel,
  findActiveSonarSensor,
  isInsideActiveSonarCone,
  isRadarTargetable,
  resolveActiveSonarHalfAngleDeg,
  resolveActiveSonarMaxRangeNm,
  type GameSave,
  type RadarContact,
  type RadarSignature,
  type UnitState,
} from '@war-patrol/shared';

export type ActiveSonarPicture = {
  contacts: RadarContact[];
  maxRangeNm: number;
  halfAngleDeg: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'sonar_off';
};

/**
 * Forward-cone active search sonar picture (destroyer Sensors).
 * Only paints when the operator toggle is ON. Contacts are anonymous polar
 * echoes (Contact N / bearing / range / signature) like radar, limited to the
 * cone about own heading.
 */
export function buildActiveSonarContacts(own: UnitState, save: GameSave): ActiveSonarPicture {
  const sensor = findActiveSonarSensor(own);
  const halfAngleDeg = resolveActiveSonarHalfAngleDeg();

  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      halfAngleDeg,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = resolveActiveSonarMaxRangeNm(sensor);

  const sensorOk = canUseSensors(own);
  if (!sensorOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      halfAngleDeg,
      operational: false,
      unavailableReason: sensorOk.reason,
    };
  }

  if (!own.activeSonarEnabled) {
    return {
      contacts: [],
      maxRangeNm,
      halfAngleDeg,
      operational: false,
      unavailableReason: 'sonar_off',
    };
  }

  const contacts: RadarContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    if (!isRadarTargetable(other)) continue;
    // Active sonar is underwater search — skip aircraft.
    if (other.type === 'Aircraft') continue;

    const signature = resolveSignature(other);
    const detectRange = maxRangeNm * RADAR_SIGNATURE_RANGE_FACTOR[signature];
    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > detectRange || rangeNm <= 0) continue;
    if (!isInsideActiveSonarCone(own.heading, bearing, halfAngleDeg)) continue;

    const rangeFactor = Math.max(0, 1 - rangeNm / detectRange);
    const strength = Math.min(
      1,
      Math.max(0.12, rangeFactor * RADAR_SIGNATURE_STRENGTH[signature]),
    );

    contacts.push({
      id: `s-${hashTrackId(own.id, other.id)}`,
      labelN: ensureContactLabel(own, other.id),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, halfAngleDeg, operational: true };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.class ?? unit.type);
}

function hashTrackId(ownId: string, otherId: string): string {
  let h = 2166136261;
  const s = `${ownId}|${otherId}|sonar`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
