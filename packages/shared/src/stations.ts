import type { HullClass, StationDef } from './types.js';
import { isHullClass, resolveVesselIdentity } from './vessel.js';

/** Canonical station ids for the two-screen player layout. */
export const STATION_ID_CONTROLS = 'controls' as const;
export const STATION_ID_SENSORS = 'sensors' as const;

/**
 * v1 player vessels expose exactly two screens:
 * - Controls — helm / EOT / dive (sub) / per-weapon CRT tabs / Damage
 *   (+ quiet ambient BT bed; sub hull creaks when submerged)
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

/**
 * Instrument tabs inside the Controls CRT (not separate station join URLs).
 * Weapon systems are first-class tabs — there is no generic “Weapons” panel.
 */
export type ControlsInstrumentTab =
  | 'helm'
  | 'eot'
  | 'dive'
  | 'torpedoes'
  | 'guns'
  | 'depth_charges'
  | 'damage';

export type ControlsInstrumentTabDef = {
  id: ControlsInstrumentTab;
  label: string;
};

/**
 * Ordered Controls CRT tabs for a hull class (museum demo: DD + fleet sub).
 * Mirrors Sensors’ per-instrument tabs (Radar / Sonar / …).
 */
export function controlsInstrumentTabsForHull(
  hullClassOrType: HullClass | string | undefined,
): ControlsInstrumentTabDef[] {
  const { class: hullClass } = resolveVesselIdentity({
    type: hullClassOrType,
    class: isHullClass(hullClassOrType) ? hullClassOrType : undefined,
  });

  const tabs: ControlsInstrumentTabDef[] = [
    { id: 'helm', label: 'Helm' },
    { id: 'eot', label: 'Engine orders' },
  ];

  if (hullClass === 'Fleet Submarine') {
    tabs.push({ id: 'dive', label: 'Dive Plane' });
    tabs.push({ id: 'torpedoes', label: 'Torpedoes' });
    tabs.push({ id: 'guns', label: 'Guns' });
  } else if (hullClass === 'Destroyer') {
    tabs.push({ id: 'guns', label: 'Guns' });
    tabs.push({ id: 'depth_charges', label: 'Depth charges' });
  }

  tabs.push({ id: 'damage', label: 'Damage' });
  return tabs;
}
