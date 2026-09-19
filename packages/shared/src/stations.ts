import type { HullClass, StationDef } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Canonical station ids for the two-screen player layout. */
export const STATION_ID_CONTROLS = 'controls' as const;
export const STATION_ID_SENSORS = 'sensors' as const;

/**
 * v1 player vessels expose exactly two screens:
 * - Controls — helm / EOT / orders (+ quiet ambient BT bed)
 * - Sensors — all sensor instruments
 */
export function defaultTwoScreenStations(
  hullClassOrType: HullClass | string | undefined,
): StationDef[] {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });

  const controls: StationDef = {
    id: STATION_ID_CONTROLS,
    name: 'Controls',
    capabilities: ['helm', 'engineering', 'plot', 'weapons'],
  };

  switch (hullClass) {
    case 'Destroyer':
      return [
        controls,
        {
          id: STATION_ID_SENSORS,
          name: 'Sensors',
          // lookout = bridge lookout (same visual FoW as sub periscope; always available)
          capabilities: ['radar', 'active_sonar', 'lookout'],
        },
      ];
    case 'Fleet Submarine':
      return [
        {
          id: STATION_ID_CONTROLS,
          name: 'Controls',
          capabilities: ['helm', 'engineering', 'plot', 'weapons', 'torpedo'],
        },
        {
          id: STATION_ID_SENSORS,
          name: 'Sensors',
          // lookout = periscope optics on the Sensors CRT
          capabilities: ['radar', 'hydrophone', 'lookout'],
        },
      ];
    case 'Cruiser':
    case 'Battleship':
    case 'Aircraft Carrier':
      return [
        controls,
        {
          id: STATION_ID_SENSORS,
          name: 'Sensors',
          capabilities: ['radar'],
        },
      ];
    case 'Merchant':
    case 'Oiler':
      return [controls];
    default:
      return [];
  }
}

/** True when the station list is already the two-screen Controls + Sensors model. */
export function isTwoScreenStationLayout(stations: StationDef[] | undefined): boolean {
  if (!stations || stations.length === 0) return false;
  const ids = new Set(stations.map((s) => s.id));
  return ids.has(STATION_ID_CONTROLS) || ids.has(STATION_ID_SENSORS);
}
