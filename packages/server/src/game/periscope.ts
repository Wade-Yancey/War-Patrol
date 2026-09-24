import {
  bearingRangeNm,
  canUseLookoutOptics,
  coarsenPeriscopeCourseDeg,
  coarsenPeriscopeRangeNm,
  coarsenPeriscopeSpeedKn,
  coarsenRelativeBearingDeg,
  ensureContactLabel,
  findLookoutSensor,
  isPeriscopeDepthOk,
  isPeriscopeRaised,
  isPeriscopeTargetable,
  isRaisedPeriscopeSpottable,
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
  unavailableReason?:
    | 'no_sensor'
    | 'sunk'
    | 'sensors_disabled'
    | 'too_deep'
    | 'scope_down';
};

/**
 * Server-authoritative periscope / lookout picture (visual stub).
 *
 * Subs: mast must be raised AND keel ≤ periscope depth; sensors casualty still knocks
 * out the periscope. Scope down → optically blind (no contacts / stale data).
 * Surface ships (DD lookout): available whenever not sunk — lookout is immune
 * to sensors-subsystem combat damage. DD lookout always sees raised enemy
 * periscope feathers (exposure &gt; 0) in visual range — deterministic FoW,
 * no spot roll.
 *
 * Bearing / range / course / speed readouts are instrument-precise (ground
 * truth, only display-rounded) — optics FoW is limited to *detection*
 * (raised-mast feathers, depth/exposure gating) and Contact-N anonymity, not
 * to smearing the numbers once a contact is visible.
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

  // Fleet-sub mast toggle — surface lookout has no mast.
  if (own.type === 'Submarine' && !isPeriscopeRaised(own)) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: 'scope_down',
    };
  }

  const contacts: PeriscopeContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;

    if (isPeriscopeTargetable(other)) {
      const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
      if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

      const { class: silhouetteClass } = resolveVesselIdentity({
        type: other.type,
        class: other.class,
      });

      contacts.push({
        id: `p-${hashTrackId(own.id, other.id)}`,
        labelN: ensureContactLabel(own, other.id),
        kind: 'hull',
        relativeBearing: coarsenRelativeBearingDeg(relativeBearingDeg(own.heading, bearing)),
        rangeNm: coarsenPeriscopeRangeNm(rangeNm),
        speedKn: coarsenPeriscopeSpeedKn(other.speed),
        courseDeg: coarsenPeriscopeCourseDeg(other.heading),
        silhouetteClass: silhouetteClass as HullClass,
      });
      continue;
    }

    // DD / ship lookout: exposed enemy mast in range → feather always painted
    // (operators watch the screen; no probability roll).
    if (own.type === 'Ship' && isRaisedPeriscopeSpottable(other)) {
      const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
      if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

      contacts.push({
        id: `pf-${hashTrackId(own.id, other.id)}`,
        labelN: ensureContactLabel(own, other.id),
        kind: 'periscope',
        relativeBearing: coarsenRelativeBearingDeg(
          relativeBearingDeg(own.heading, bearing),
        ),
        rangeNm: coarsenPeriscopeRangeNm(rangeNm),
        speedKn: 0,
        // No courseDeg — feather/stick gives no reliable aspect estimate.
        silhouetteClass: 'Fleet Submarine',
      });
    }
  }

  // Display order by relative bearing / range — labels stay on the designation book.
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
