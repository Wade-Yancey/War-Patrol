import type {
  ClientView,
  GameSave,
  TrailPoint,
  UnitState,
  UnitTrail,
  UmpireView,
  VesselView,
} from '@war-patrol/shared';
import {
  DEPTH_CHARGE_CONTROLS_AUDIBLE_NM,
  bearingRangeNm,
  buildOwnDamageLog,
  isV1PlayerUnit,
} from '@war-patrol/shared';
import type { SseHub } from './sse.js';
import { buildActiveSonarContacts } from './activeSonar.js';
import { buildHydrophoneContacts } from './hydrophone.js';
import { buildPeriscopeContacts } from './periscope.js';
import { buildRadarContacts } from './radar.js';
import { buildTorpedoWakeCues } from './wakeCues.js';

/**
 * Close-aboard depth-charge cues for Controls speakers.
 *
 * Range is measured from **this vessel's position** to each detonation —
 * never filtered by firer / own-weapon. Any hull within
 * {@link DEPTH_CHARGE_CONTROLS_AUDIBLE_NM} hears the blast (DD dropper and
 * nearby sub alike).
 */
export function buildBridgeDetonations(
  unit: UnitState,
  save: GameSave,
): NonNullable<VesselView['bridgeDetonations']> {
  const bridge: NonNullable<VesselView['bridgeDetonations']> = [];
  // Keep cues for the resolve turn and the following open turn.
  const oldestTurn = save.turn.number - 1;
  for (const d of save.recentDetonations ?? []) {
    if (d.kind !== 'depth_charge') continue;
    if (d.turnNumber < oldestTurn) continue;
    const { bearing, rangeNm } = bearingRangeNm(unit.position, d.position);
    if (rangeNm > DEPTH_CHARGE_CONTROLS_AUDIBLE_NM) continue;
    bridge.push({
      id: d.id,
      bearing: Math.round(bearing * 10) / 10,
      rangeNm: Math.round(rangeNm * 100) / 100,
    });
  }
  return bridge;
}

/** Build umpire polylines from start positions + history snapshots + current. */
export function buildUnitTrails(save: GameSave): UnitTrail[] {
  const history = [...save.history].sort((a, b) => a.turnNumber - b.turnNumber);
  return save.units.map((unit) => {
    const points: TrailPoint[] = [];
    const push = (lat: number, lon: number, turnNumber: number) => {
      const last = points[points.length - 1];
      if (
        last &&
        Math.abs(last.lat - lat) < 1e-7 &&
        Math.abs(last.lon - lon) < 1e-7
      ) {
        return;
      }
      points.push({ lat, lon, turnNumber });
    };

    const origin = save.startTrails?.find((t) => t.unitId === unit.id)?.points[0];
    if (origin) push(origin.lat, origin.lon, origin.turnNumber);

    for (const snap of history) {
      const u = snap.units.find((x) => x.id === unit.id);
      if (!u) continue;
      push(u.position.lat, u.position.lon, snap.turnNumber);
    }

    push(unit.position.lat, unit.position.lon, save.turn.number);
    return { unitId: unit.id, points };
  });
}

function vesselLinkForUnit(save: GameSave, u: UnitState) {
  const playerVessel = isV1PlayerUnit(u);
  return {
    unitId: u.id,
    name: u.name,
    accessToken: u.accessToken,
    passwordProtected: Boolean(u.password),
    playerVessel,
    // v1: station join URLs only for Destroyer + Fleet Submarine.
    stations: playerVessel
      ? u.stations.map((s) => ({
          stationId: s.id,
          name: s.name,
          path: `/g/${save.id}/v/${u.accessToken}/s/${s.id}`,
        }))
      : [],
  };
}

export function buildUmpireView(save: GameSave, sse: SseHub): UmpireView {
  return {
    role: 'umpire',
    gameId: save.id,
    name: save.name,
    scenarioId: save.scenarioId,
    scenarioName: save.scenarioName,
    mode: save.mode,
    operatingArea: save.operatingArea,
    stateVersion: save.stateVersion,
    turn: save.turn,
    turnLengthSeconds: save.turnLengthSeconds,
    units: save.units,
    trails: buildUnitTrails(save),
    torpedoes: save.torpedoes ?? [],
    depthCharges: save.depthCharges ?? [],
    recentDetonations: save.recentDetonations ?? [],
    combatLog: save.combatLog ?? [],
    historyTurnNumbers: save.history.map((h) => h.turnNumber),
    vesselLinks: save.units.map((u) => vesselLinkForUnit(save, u)),
    connections: sse.connectionSummary(save.id),
  };
}

export function buildVesselView(
  save: GameSave,
  unit: UnitState,
  stationId: string,
  sse: SseHub,
): VesselView | null {
  const station = unit.stations.find((s) => s.id === stationId);
  if (!station) return null;

  const canOrder =
    save.turn.phase === 'open' &&
    (station.capabilities.includes('helm') ||
      station.capabilities.includes('engineering') ||
      station.capabilities.includes('weapons') ||
      station.capabilities.includes('torpedo'));

  const view: VesselView = {
    role: 'vessel',
    gameId: save.id,
    name: save.name,
    stateVersion: save.stateVersion,
    turn: save.turn,
    turnLengthSeconds: save.turnLengthSeconds,
    unit: {
      id: unit.id,
      name: unit.name,
      side: unit.side,
      faction: unit.faction,
      type: unit.type,
      class: unit.class,
      position: unit.position,
      flightLevel: unit.flightLevel,
      condition: unit.condition,
      subsystems: unit.subsystems,
      heading: unit.heading,
      orderedCourse: unit.orderedCourse,
      orderedDepth: unit.orderedDepth,
      speed: unit.speed,
      eot: unit.eot,
      orders: unit.orders,
      health: unit.health,
      maxSpeed: unit.maxSpeed,
      turnRate: unit.turnRate,
      radarSignature: unit.radarSignature,
      stations: unit.stations,
      activeSonarEnabled: Boolean(unit.activeSonarEnabled),
      torpedoLoad: unit.torpedoLoad ?? 0,
      depthChargeLoad: unit.depthChargeLoad ?? 0,
    },
    stationId,
    station,
    stationConnections: sse.stationConnectionCounts(save.id, unit.id),
    canSubmitOrders: canOrder,
  };

  // Own-side weapon tracks (crew knows what they launched).
  view.ownTorpedoes = (save.torpedoes ?? []).filter((t) => t.firerUnitId === unit.id);
  view.ownDepthCharges = (save.depthCharges ?? []).filter((c) => c.firerUnitId === unit.id);

  // Own-ship damage report (hits / casualties on this hull only).
  const ownDamage = buildOwnDamageLog(unit.id, save.combatLog);
  if (ownDamage.length) view.ownDamageLog = ownDamage;

  // Controls bridge DC audio: every vessel in range of the blast, not only the dropper.
  // Gate on Controls station (helm/weapons/torpedo OR station id), never on firerUnitId.
  const onControlsStation =
    stationId === 'controls' ||
    station.capabilities.includes('helm') ||
    station.capabilities.includes('weapons') ||
    station.capabilities.includes('torpedo') ||
    station.capabilities.includes('engineering');
  if (onControlsStation) {
    const bridge = buildBridgeDetonations(unit, save);
    if (bridge.length) view.bridgeDetonations = bridge;
  }

  if (station.capabilities.includes('radar')) {
    const radar = buildRadarContacts(unit, save);
    view.radarContacts = radar.contacts;
    view.radarMaxRangeNm = radar.maxRangeNm;
    view.radarOperational = radar.operational;
    if (radar.unavailableReason) {
      view.radarUnavailableReason = radar.unavailableReason;
    }
  }

  if (station.capabilities.includes('hydrophone')) {
    const hydro = buildHydrophoneContacts(unit, save);
    view.hydrophoneContacts = hydro.contacts;
    view.hydrophoneMaxRangeNm = hydro.maxRangeNm;
    view.hydrophoneOperational = hydro.operational;
    if (hydro.unavailableReason) {
      view.hydrophoneUnavailableReason = hydro.unavailableReason;
    }
  }

  if (station.capabilities.includes('active_sonar')) {
    const sonar = buildActiveSonarContacts(unit, save);
    view.sonarContacts = sonar.contacts;
    view.sonarMaxRangeNm = sonar.maxRangeNm;
    view.sonarHalfAngleDeg = sonar.halfAngleDeg;
    view.sonarOperational = sonar.operational;
    if (sonar.unavailableReason) {
      view.sonarUnavailableReason = sonar.unavailableReason;
    }
  }

  if (station.capabilities.includes('lookout')) {
    const peri = buildPeriscopeContacts(unit, save);
    view.periscopeContacts = peri.contacts;
    view.periscopeMaxRangeNm = peri.maxRangeNm;
    view.periscopeOperational = peri.operational;
    if (peri.unavailableReason) {
      view.periscopeUnavailableReason = peri.unavailableReason;
    }
    const wakes = buildTorpedoWakeCues(unit, save);
    if (wakes.length) view.torpedoWakeCues = wakes;
  }

  return view;
}

export function buildViewForSession(
  save: GameSave,
  sse: SseHub,
  role: 'umpire' | 'vessel',
  unitId?: string,
  stationId?: string,
): ClientView | null {
  if (role === 'umpire') return buildUmpireView(save, sse);
  if (!unitId || !stationId) return null;
  const unit = save.units.find((u) => u.id === unitId);
  if (!unit) return null;
  return buildVesselView(save, unit, stationId, sse);
}
