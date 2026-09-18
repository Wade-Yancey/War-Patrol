import {
  RADAR_MAX_RANGE_NM,
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  defaultRadarSignature,
  type GameSave,
  type RadarContact,
  type RadarSignature,
  type UnitState,
} from '@war-patrol/shared';

/** Depth (m) at/above which a contact is treated as surface-visible to radar. */
const SURFACE_DEPTH_M = 5;

/**
 * Minimal server-authoritative radar picture (ARCH-DET / ARCH-SP-05).
 * Own ship never appears. Other units are reduced to opaque polar blips —
 * no absolute positions, names, sides, or class leak to the client.
 */
export function buildRadarContacts(own: UnitState, save: GameSave): {
  contacts: RadarContact[];
  maxRangeNm: number;
} {
  const maxRangeNm = RADAR_MAX_RANGE_NM;
  const contacts: RadarContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    if (other.position.depth > SURFACE_DEPTH_M) continue;

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
    });
  }

  // Bearing order — operator reads Contact 1…N as raw sensor indices.
  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm };
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
