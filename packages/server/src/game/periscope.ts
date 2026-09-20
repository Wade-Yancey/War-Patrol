import {
  bearingRangeNm,
  canUseLookoutOptics,
  coarsenPeriscopeRangeNm,
  coarsenPeriscopeSpeedKn,
  coarsenRelativeBearingDeg,
  findLookoutSensor,
  isPeriscopeDepthOk,
  isPeriscopeRaised,
  isPeriscopeTargetable,
  isRaisedPeriscopeSpottable,
  normalizeHeading,
  periscopeSpotObservationError,
  periscopeSpotProbability,
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
 * Subs: mast must be raised AND keel ≤ 18 m; sensors casualty still knocks
 * out the periscope. Scope down → optically blind (no contacts / stale data).
 * Surface ships (DD lookout): available whenever not sunk — lookout is immune
 * to sensors-subsystem combat damage. DD lookout can also spot raised enemy
 * periscope feathers (not full sub ID) with bearing/range error.
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
        kind: 'hull',
        relativeBearing: coarsenRelativeBearingDeg(relativeBearingDeg(own.heading, bearing)),
        rangeNm: coarsenPeriscopeRangeNm(rangeNm),
        speedKn: coarsenPeriscopeSpeedKn(other.speed),
        silhouetteClass: silhouetteClass as HullClass,
      });
      continue;
    }

    // DD / ship lookout: chance to spot a raised periscope feather.
    if (own.type === 'Ship' && isRaisedPeriscopeSpottable(other)) {
      const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
      if (rangeNm > maxRangeNm || rangeNm <= 0) continue;
      const p = periscopeSpotProbability(rangeNm, maxRangeNm);
      const rollSeed = `${save.id}|${own.id}|${other.id}|peri-spot|${save.turn.number}`;
      if (spotRng01(rollSeed) > p) continue;

      const err = periscopeSpotObservationError(rollSeed);
      const noisyBearing = normalizeHeading(bearing + err.bearingErrDeg);
      const noisyRange = Math.max(0.1, rangeNm + err.rangeErrNm);

      contacts.push({
        id: `pf-${hashTrackId(own.id, other.id)}`,
        kind: 'periscope',
        relativeBearing: coarsenRelativeBearingDeg(
          relativeBearingDeg(own.heading, noisyBearing),
        ),
        rangeNm: coarsenPeriscopeRangeNm(noisyRange),
        speedKn: 0,
        silhouetteClass: 'Fleet Submarine',
      });
    }
  }

  contacts.sort(
    (a, b) =>
      Math.abs(a.relativeBearing) - Math.abs(b.relativeBearing) || a.rangeNm - b.rangeNm,
  );
  return { contacts, maxRangeNm, operational: true };
}

function spotRng01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return (x >>> 0) / 4294967296;
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
