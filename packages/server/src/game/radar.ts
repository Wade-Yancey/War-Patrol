import {
  RADAR_MAX_RANGE_NM,
  RADAR_SIGNATURE_RANGE_FACTOR,
  RADAR_SIGNATURE_STRENGTH,
  bearingRangeNm,
  canUseSensorStation,
  defaultRadarSignature,
  ensureContactLabel,
  findRadarSensor,
  isRadarSurfaced,
  isRadarTargetable,
  type GameSave,
  type RadarContact,
  type RadarGhostOwnShip,
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

/** One-turn-deep previous-turn ghosts for the radar PPI. */
export type RadarGhostPicture = {
  contacts: RadarContact[];
  ownShip?: RadarGhostOwnShip;
};

/** Minimum own-ship displacement (nm) before drawing a previous-own mark. */
const GHOST_OWN_MIN_RANGE_NM = 0.01;

/**
 * Unit states from the prior resolve (end of last turn), for one-turn ghosts.
 * After the first resolve, falls back to `openingSnapshot` (scenario start).
 * Returns undefined when no prior turn exists yet.
 */
export function previousTurnUnitStates(save: GameSave): UnitState[] | undefined {
  const history = save.history ?? [];
  if (history.length === 0) return undefined;
  if (history.length === 1) {
    return save.openingSnapshot?.units;
  }
  return history[history.length - 2]?.units;
}

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
    });
  }

  // Bearing order for the table — Contact N comes from the designation book, not index.
  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { contacts, maxRangeNm, operational: true };
}

/**
 * Previous-turn radar ghosts for the PPI (Wade trial, one turn deep).
 *
 * - Own-ship mark: last-resolve own position relative to **current** own (center).
 * - Contact ghosts: contacts that were painted last turn, reprojected from their
 *   **last-turn geo** into the current PPI — never paste last BRG/RNG onto center.
 * - Hydrophone unchanged; no invented course/speed from ghosts.
 */
export function buildRadarGhosts(own: UnitState, save: GameSave): RadarGhostPicture {
  const empty: RadarGhostPicture = { contacts: [] };
  const prevUnits = previousTurnUnitStates(save);
  if (!prevUnits) return empty;

  const prevOwn = prevUnits.find((u) => u.id === own.id);
  if (!prevOwn) return empty;

  const ownShip = ghostOwnShipMark(own.position, prevOwn.position);

  const sensor = findRadarSensor(prevOwn);
  if (!sensor) return { ownShip, contacts: [] };

  const sensorOk = canUseSensorStation(prevOwn, 'radar');
  if (!sensorOk.ok || !isRadarSurfaced(prevOwn.position)) {
    return { ownShip, contacts: [] };
  }

  const maxRangeNm = sensor.maxRangeNm ?? RADAR_MAX_RANGE_NM;
  const contacts: RadarContact[] = [];

  for (const other of prevUnits) {
    if (other.id === own.id) continue;
    if (!isRadarTargetable(other)) continue;
    if (!isRadarSurfaced(other.position)) continue;

    const signature = resolveSignature(other);
    const detectRange = maxRangeNm * RADAR_SIGNATURE_RANGE_FACTOR[signature];
    const prevRel = bearingRangeNm(prevOwn.position, other.position);
    if (prevRel.rangeNm > detectRange || prevRel.rangeNm <= 0) continue;

    // World-true vs current own (do NOT reuse prevRel BRG/RNG).
    const { bearing, rangeNm } = bearingRangeNm(own.position, other.position);
    if (rangeNm <= 0) continue;

    const rangeFactor = Math.max(0, 1 - prevRel.rangeNm / detectRange);
    const strength = Math.min(
      1,
      Math.max(0.12, rangeFactor * RADAR_SIGNATURE_STRENGTH[signature]),
    );

    contacts.push({
      id: `rg-${opaqueTrackId([own.id, other.id])}`,
      labelN: ensureContactLabel(own, other.id),
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
      strength: Math.round(strength * 100) / 100,
      signature,
    });
  }

  contacts.sort((a, b) => a.bearing - b.bearing || a.rangeNm - b.rangeNm);
  return { ownShip, contacts };
}

/** Polar previous-own mark when the hull actually moved since last resolve. */
export function ghostOwnShipMark(
  currentOwn: Pick<UnitState['position'], 'lat' | 'lon'>,
  previousOwn: Pick<UnitState['position'], 'lat' | 'lon'>,
): RadarGhostOwnShip | undefined {
  const { bearing, rangeNm } = bearingRangeNm(currentOwn, previousOwn);
  if (rangeNm < GHOST_OWN_MIN_RANGE_NM) return undefined;
  return {
    bearing: Math.round(bearing * 10) / 10,
    rangeNm: Math.round(rangeNm * 100) / 100,
  };
}

function resolveSignature(unit: UnitState): RadarSignature {
  return unit.radarSignature ?? defaultRadarSignature(unit.class ?? unit.type);
}

