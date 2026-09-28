import {
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  canUseSensorStation,
  coarsenActiveSonarDepthM,
  defaultRadarSignature,
  ensureContactLabel,
  findActiveSonarSensor,
  isInsideActiveSonarCone,
  isRadarTargetable,
  resolveActiveSonarHalfAngleDeg,
  resolveActiveSonarMaxRangeNm,
  type GameSave,
  type RadarContact,
  type RadarGhostOwnShip,
  type RadarSignature,
  type UnitState,
} from '@war-patrol/shared';
import { opaqueTrackId } from './opaqueTrackId.js';
import { ghostOwnShipMark, previousTurnUnitStates } from './radar.js';

export type ActiveSonarPicture = {
  contacts: RadarContact[];
  maxRangeNm: number;
  halfAngleDeg: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'sonar_off';
};

/** One-turn-deep previous-turn ghosts for the active-sonar scope. */
export type ActiveSonarGhostPicture = {
  contacts: RadarContact[];
  ownShip?: RadarGhostOwnShip;
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
      estimatedDepthM: coarsenActiveSonarDepthM(other.position.depth),
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, halfAngleDeg, operational: true };
}

/**
 * Previous-turn active-sonar ghosts (same one-turn world-true treatment as radar).
 * Only contacts that were inside the cone and painted last turn; reprojected vs
 * current own. No invented course/speed.
 */
export function buildActiveSonarGhosts(own: UnitState, save: GameSave): ActiveSonarGhostPicture {
  const empty: ActiveSonarGhostPicture = { contacts: [] };
  const prevUnits = previousTurnUnitStates(save);
  if (!prevUnits) return empty;

  const prevOwn = prevUnits.find((u) => u.id === own.id);
  if (!prevOwn) return empty;

  const ownShip = ghostOwnShipMark(own.position, prevOwn.position);
  const sensor = findActiveSonarSensor(prevOwn);
  if (!sensor) return { ownShip, contacts: [] };

  const sensorOk = canUseSensorStation(prevOwn, 'active_sonar');
  if (!sensorOk.ok || !prevOwn.activeSonarEnabled) {
    return { ownShip, contacts: [] };
  }

  const halfAngleDeg = resolveActiveSonarHalfAngleDeg();
  const maxRangeNm = resolveActiveSonarMaxRangeNm(sensor);
  const contacts: RadarContact[] = [];

  for (const other of prevUnits) {
    if (other.id === own.id) continue;
    if (!isRadarTargetable(other)) continue;
    if (other.type === 'Aircraft') continue;

    const signature = resolveSignature(other);
    const detectRange = maxRangeNm * RADAR_SIGNATURE_RANGE_FACTOR[signature];
    const prevRel = bearingRangeNm(prevOwn.position, other.position);
    if (prevRel.rangeNm > detectRange || prevRel.rangeNm <= 0) continue;
    if (!isInsideActiveSonarCone(prevOwn.heading, prevRel.bearing, halfAngleDeg)) continue;

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm <= 0) continue;

    const rangeFactor = Math.max(0, 1 - prevRel.rangeNm / detectRange);
    const strength = Math.min(
      1,
      Math.max(0.12, rangeFactor * RADAR_SIGNATURE_STRENGTH[signature]),
    );

    contacts.push({
      id: `sg-${opaqueTrackId([own.id, other.id, 'sonar'])}`,
      labelN: ensureContactLabel(own, other.id),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
      estimatedDepthM: coarsenActiveSonarDepthM(other.position.depth),
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { ownShip, contacts };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.class ?? unit.type);
}
