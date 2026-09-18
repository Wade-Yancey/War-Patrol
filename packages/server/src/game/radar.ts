import {
  RADAR_MAX_RANGE_NM,
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  defaultRadarSignature,
  findRadarSensor,
  isRadarSurfaced,
  type GameSave,
  type RadarContact,
  type RadarSignature,
  type UnitState,
} from '@war-patrol/shared';

export type RadarPicture = {
  contacts: RadarContact[];
  maxRangeNm: number;
  operational: boolean;
  unavailableReason?: 'submerged' | 'no_sensor';
};

/**
 * Minimal server-authoritative radar picture (ARCH-DET / ARCH-SP-05).
 * Requires an installed radar sensor. Own-ship PPI only when surfaced.
 * Targets only paint when they are surfaced — no absolute positions/names/sides.
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
      id: `r-${hashTrackId(own.id, other.id)}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
    });
  }

  // Bearing order — operator reads Contact 1…N as raw sensor indices.
  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, operational: true };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.type);
}

/** Stable opaque track id — not reversible to unit id without the own-ship salt. */
function hashTrackId(ownId: string, otherId: string): string {
  let h = 2166136261;
  const s = `${ownId}|${otherId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
