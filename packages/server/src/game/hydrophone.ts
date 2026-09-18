import {
  bearingRangeNm,
  canUseSensors,
  findHydrophoneSensor,
  isHydrophoneEmitter,
  resolveHydrophoneMaxRangeNm,
  type GameSave,
  type HydrophoneContact,
  type UnitState,
} from '@war-patrol/shared';

export type HydrophonePicture = {
  contacts: HydrophoneContact[];
  maxRangeNm: number;
  operational: boolean;
  unavailableReason?: 'no_sensor' | 'sunk' | 'sensors_disabled';
};

/**
 * Server-authoritative hydrophone cues (audio only).
 *
 * Uses ground-truth positions for relative bearing/range so operators can hear
 * beyond radar FoW. Own ship is excluded. Only underway waterborne hulls emit.
 * Contacts are anonymous polar cues — never drawn as PPI blips.
 */
export function buildHydrophoneContacts(own: UnitState, save: GameSave): HydrophonePicture {
  const sensor = findHydrophoneSensor(own);
  if (!sensor) {
    return {
      contacts: [],
      maxRangeNm: 0,
      operational: false,
      unavailableReason: 'no_sensor',
    };
  }

  const maxRangeNm = resolveHydrophoneMaxRangeNm(sensor);

  const sensorOk = canUseSensors(own);
  if (!sensorOk.ok) {
    return {
      contacts: [],
      maxRangeNm,
      operational: false,
      unavailableReason: sensorOk.reason,
    };
  }

  const contacts: HydrophoneContact[] = [];

  for (const other of save.units) {
    if (other.id === own.id) continue;
    if (!isHydrophoneEmitter(other)) continue;

    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm > maxRangeNm || rangeNm <= 0) continue;

    contacts.push({
      id: `h-${hashTrackId(own.id, other.id)}`,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, operational: true };
}

/** Stable opaque track id — not reversible to unit id without the own-ship salt. */
function hashTrackId(ownId: string, otherId: string): string {
  let h = 2166136261;
  const s = `${ownId}|${otherId}|hydro`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}
