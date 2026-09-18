import type {
  ClientView,
  GameSave,
  TrailPoint,
  UnitState,
  UnitTrail,
  UmpireView,
  VesselView,
} from '@war-patrol/shared';
import type { SseHub } from './sse.js';
import { buildRadarContacts } from './radar.js';

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
    historyTurnNumbers: save.history.map((h) => h.turnNumber),
    vesselLinks: save.units.map((u) => ({
      unitId: u.id,
      name: u.name,
      accessToken: u.accessToken,
      passwordProtected: Boolean(u.password),
      stations: u.stations.map((s) => ({
        stationId: s.id,
        name: s.name,
        path: `/g/${save.id}/v/${u.accessToken}/s/${s.id}`,
      })),
    })),
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
    (station.capabilities.includes('helm') || station.capabilities.includes('engineering'));

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
      type: unit.type,
      position: unit.position,
      heading: unit.heading,
      orderedCourse: unit.orderedCourse,
      speed: unit.speed,
      eot: unit.eot,
      orders: unit.orders,
      health: unit.health,
      maxSpeed: unit.maxSpeed,
      turnRate: unit.turnRate,
      radarSignature: unit.radarSignature,
      stations: unit.stations,
    },
    stationId,
    station,
    stationConnections: sse.stationConnectionCounts(save.id, unit.id),
    canSubmitOrders: canOrder,
  };

  if (station.capabilities.includes('radar')) {
    const radar = buildRadarContacts(unit, save);
    view.radarContacts = radar.contacts;
    view.radarMaxRangeNm = radar.maxRangeNm;
    view.radarOperational = radar.operational;
    if (radar.unavailableReason) {
      view.radarUnavailableReason = radar.unavailableReason;
    }
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
