import {
  RADAR_MAX_RANGE_NM,
  bearingRangeNm,
  type GameSave,
  type RadarContact,
  type UnitState,
} from '@war-patrol/shared';

/** Depth (m) at/above which a contact is treated as surface-visible to radar. */
const SURFACE_DEPTH_M = 5;

/**
 * Minimal server-authoritative radar picture (ARCH-DET / ARCH-SP-05).
 * Own ship never appears. Other units are reduced to opaque polar blips —
 * no absolute positions, names, or sides leak to the client.
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

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

    const strength = Math.max(0.15, 1 - rangeNm / maxRangeNm);
    contacts.push({
      id: `r-${hashTrackId(own.id, other.id)}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing);
  return { contacts, maxRangeNm };
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
