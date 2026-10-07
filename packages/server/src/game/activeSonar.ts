import {
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  activeNoisemakers,
  bearingRangeNm,
  canUseSensorStation,
  coarsenActiveSonarDepthM,
  coarsenPeriscopeCourseDeg,
  defaultRadarSignature,
  ensureContactLabel,
  radarContactDomain,
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
import { opaqueTrackId } from './opaqueTrackId.js';

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
 * echoes (Contact N / bearing / range / signature / estimated depth) like
 * radar, limited to the cone about own heading. 100% accurate like radar —
 * bearing / range / depth are ground truth (display-rounded only); FoW here
 * is limited to detection gating (cone, range, toggle) and Contact-N anonymity.
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

  const sensorOk = canUseSensorStation(own, 'active_sonar');
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
      id: `s-${opaqueTrackId([own.id, other.id, 'sonar'])}`,
      labelN: ensureContactLabel(own, other.id),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
      domain: radarContactDomain(other),
      courseDeg: coarsenPeriscopeCourseDeg(other.heading),
      estimatedDepthM: coarsenActiveSonarDepthM(other.position.depth),
    });
  }

  // Stationary noisemaker decoys paint as anonymous small submerged echoes —
  // attract/distract ASW without revealing decoy identity (Contact N only).
  const decoySignature: RadarSignature = 'small';
  const decoyDetect = maxRangeNm * RADAR_SIGNATURE_RANGE_FACTOR[decoySignature];
  for (const nm of activeNoisemakers(save.noisemakers)) {
    const { bearing, rangeNm } = bearingRangeNm(own.position, nm.position);
    if (rangeNm > decoyDetect || rangeNm <= 0) continue;
    if (!isInsideActiveSonarCone(own.heading, bearing, halfAngleDeg)) continue;
    const rangeFactor = Math.max(0, 1 - rangeNm / decoyDetect);
    const strength = Math.min(
      1,
      Math.max(0.12, rangeFactor * RADAR_SIGNATURE_STRENGTH[decoySignature]),
    );
    const trackKey = `nmkr:${nm.id}`;
    contacts.push({
      id: `s-${opaqueTrackId([own.id, nm.id, 'sonar', 'nmkr'])}`,
      labelN: ensureContactLabel(own, trackKey),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature: decoySignature,
      domain: 'surface',
      estimatedDepthM: coarsenActiveSonarDepthM(nm.position.depth),
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, halfAngleDeg, operational: true };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.class ?? unit.type);
}
