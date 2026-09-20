import {
  bearingRangeNm,
  canUseLookoutOptics,
  coarsenPeriscopeRangeNm,
  coarsenPeriscopeSpeedKn,
  coarsenRelativeBearingDeg,
  findLookoutSensor,
  isPeriscopeDepthOk,
  isPeriscopeTargetable,
  relativeBearingDeg,
  resolvePeriscopeMaxRangeNm,
  resolveVesselIdentity,
  type GameSave,
  type HullClass,
  type PeriscopeContact,
  type UnitState,
} from '@war-patrol/shared';

export type PeriscopePicture = {
  contacts: PeriscopeContact[];
  maxRangeNm: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled' | 'too_deep';
};

/**
 * Server-authoritative periscope / lookout picture (visual stub).
 *
 * Subs: available at/above periscope depth (keel ≤ 18 m); sensors subsystem
 * can still knock out the periscope.
 * Surface ships (DD lookout): available whenever not sunk — lookout is immune
 * to sensors-subsystem combat damage.
 * Short visual range only. Contacts: relative bearing, coarsened range/speed,
 * silhouette class — own ship excluded.
 */
export function buildPeriscopeContacts(own: UnitState, save: GameSave): PeriscopePicture {
  const sensor = findLookoutSensor(own);
  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = resolvePeriscopeMaxRangeNm(sensor);

  const opticsOk = canUseLookoutOptics(own);
  if (!opticsOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: opticsOk.reason,
    };
  }

  const depthOk = isPeriscopeDepthOk(own);
  if (!depthOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: depthOk.reason,
    };
  }

  const contacts: PeriscopeContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    if (!isPeriscopeTargetable(other)) continue;

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

    const { class: silhouetteClass } = resolveVesselIdentity({
      type: other.type,
      class: other.class,
    });

    contacts.push({
      id: `p-${hashTrackId(own.id, other.id)}`,
      relativeBearing: coarsenRelativeBearingDeg(relativeBearingDeg(own.heading, bearing)),
      rangeNm: coarsenPeriscopeRangeNm(rangeNm),
      speedKn: coarsenPeriscopeSpeedKn(other.speed),
      silhouetteClass: silhouetteClass as HullClass,
    });
  }

  contacts.sort(
    (a, b) =>
      Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing) || a.rangeNm - b.rangeNm,
  );
  return { contacts, maxRangeNm, operational: true };
}

function hashTrackId(ownId: string, otherId: string): string {
  let h = 2166136261;
  const s = `${ownId}|${otherId}|peri`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
