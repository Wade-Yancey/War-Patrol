import type {
  ClientView,
  GameSave,
  UnitState,
  UmpireView,
  VesselView,
} from '@war-patrol/shared';
import type { SseHub } from './sse.js';

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
    units: save.units,
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

  return {
    role: 'vessel',
    gameId: save.id,
    name: save.name,
    stateVersion: save.stateVersion,
    turn: save.turn,
    unit: {
      id: unit.id,
      name: unit.name,
      side: unit.side,
      type: unit.type,
      position: unit.position,
      heading: unit.heading,
      speed: unit.speed,
      eot: unit.eot,
      orders: unit.orders,
      health: unit.health,
      maxSpeed: unit.maxSpeed,
      stations: unit.stations,
    },
    stationId,
    station,
    stationConnections: sse.stationConnectionCounts(save.id, unit.id),
    canSubmitOrders: canOrder,
  };
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
