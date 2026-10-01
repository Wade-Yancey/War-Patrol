import {
  RADAR_MAX_RANGE_NM,
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  canUseSensorStation,
  coarsenPeriscopeCourseDeg,
  defaultRadarSignature,
  ensureContactLabel,
  findRadarSensor,
  isRadarSurfaced,
  isRadarTargetable,
  radarContactDomain,
  type GameSave,
  type RadarContact,
  type RadarSignature,
  type UnitState,
} from '@war-patrol/shared';
import { opaqueTrackId } from './opaqueTrackId.js';

export type RadarPicture = {
  contacts: RadarContact[];
  maxRangeNm: number;
  operational: boolean;
  unavailableReason?: 'submerged' | 'no_sensor' | 'sunk' | 'sensors_disabled';
};

/**
 * Minimal server-authoritative radar picture (ARCH-DET / ARCH-SP-05).
 * Requires an installed radar sensor. Own-ship PPI only when surfaced / sensors OK.
 * Targets only paint when afloat and surfaced — no absolute positions/names/sides.
 */
export function buildRadarContacts(own: UnitState, save: GameSave): RadarPicture {
  const sensor = findRadarSensor(own);
  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = sensor.maxRangeNm ?? RADAR_MAX_RANGE_NM;

  const sensorOk = canUseSensorStation(own, 'radar');
  if (!sensorOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: sensorOk.reason,
    };
  }

  if (!isRadarSurfaced(own.position)) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: 'submerged',
    };
  }

  const contacts: RadarContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    // Sunk / destroyed units do not return an echo.
    if (!isRadarTargetable(other)) continue;
    // Submerged targets do not return a radar echo.
    if (!isRadarSurfaced(other.position)) continue;

    const signature = resolveSignature(other);
    const detectRange = maxRangeNm * RADAR_SIGNATURE_RANGE_FACTOR[signature];
    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > detectRange || rangeNm <= 0) continue;

    const rangeFactor = Math.max(0, 1 - rangeNm / detectRange);
    const strength = Math.min(
      1,
      Math.max(0.12, rangeFactor * RADAR_SIGNATURE_STRENGTH[signature]),
    );

    contacts.push({
      id: `r-${opaqueTrackId([own.id, other.id])}`,
      labelN: ensureContactLabel(own, other.id),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
      domain: radarContactDomain(other),
      // FoW-safe facing for PPI chevron — true course, no identity leak.
      courseDeg: coarsenPeriscopeCourseDeg(other.heading),
    });
  }

  // Bearing order for the table — Contact N comes from the designation book, not index.
  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, operational: true };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.class ?? unit.type);
}
