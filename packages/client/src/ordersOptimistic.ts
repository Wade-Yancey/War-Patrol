import {
  clampSubmarineDepth,
  normalizeHeading,
  type DepthChargeDropOrder,
  type DeckGunFireOrder,
  type EotSetting,
  type NoisemakerDeployOrder,
  type TorpedoFireOrder,
  type UnitOrders,
} from '@war-patrol/shared';

/** Station order POST body (mirrors `/api/games/:id/orders`). */
export type StationOrdersPatch = {
  course?: number;
  eot?: EotSetting;
  depth?: number;
  emergencyBlow?: boolean;
  fireTorpedo?: TorpedoFireOrder | null;
  dropDepthCharges?: DepthChargeDropOrder | null;
  fireDeckGun?: DeckGunFireOrder | null;
  deployNoisemaker?: NoisemakerDeployOrder | null;
};

/**
 * Client-side merge for optimistic of-record chrome. Mirrors server
 * `mergeOrders` field rules closely enough for UI; POST/SSE remain authoritative.
 */
export function mergeOrdersOptimistic(
  existing: UnitOrders,
  patch: StationOrdersPatch,
  stationId: string,
): UnitOrders {
  const next: UnitOrders = {
    ...existing,
    updatedAt: new Date().toISOString(),
    updatedByStationId: stationId,
  };
  if (patch.course !== undefined) {
    next.course = normalizeHeading(patch.course);
  }
  if (patch.eot !== undefined) {
    next.eot = patch.eot;
  }
  if (patch.depth !== undefined) {
    next.depth = clampSubmarineDepth(patch.depth);
    if (patch.emergencyBlow) next.emergencyBlow = true;
    else delete next.emergencyBlow;
  }
  if (patch.fireTorpedo === null) {
    delete next.fireTorpedo;
  } else if (patch.fireTorpedo) {
    next.fireTorpedo = { ...patch.fireTorpedo };
  }
  if (patch.dropDepthCharges === null) {
    delete next.dropDepthCharges;
  } else if (patch.dropDepthCharges) {
    next.dropDepthCharges = { ...patch.dropDepthCharges };
  }
  if (patch.fireDeckGun === null) {
    delete next.fireDeckGun;
  } else if (patch.fireDeckGun) {
    next.fireDeckGun = { ...patch.fireDeckGun };
  }
  if (patch.deployNoisemaker === null) {
    delete next.deployNoisemaker;
  } else if (patch.deployNoisemaker) {
    next.deployNoisemaker = { ...patch.deployNoisemaker };
  }
  return next;
}

/**
 * Build a Controls POST patch that re-files standing helm / EOT / dive for this
 * turn without re-entering dials. Prefers already-pending of-record values when
 * present so a prior submit this turn is not overwritten by older unit.eot.
 * Omits fields blocked by station caps or jammed subsystems. Returns null when
 * nothing can be filed (button should stay disabled).
 */
export function buildContinueStandingOrdersPatch(input: {
  unitType: string;
  orderedCourse: number;
  standingEot: EotSetting;
  orderedDepth?: number;
  keelDepth?: number;
  pending: UnitOrders;
  canHelm: boolean;
  canEot: boolean;
  steeringBlocked: boolean;
  propulsionDisabled: boolean;
  divePlanesLocked: boolean;
}): StationOrdersPatch | null {
  const patch: StationOrdersPatch = {};
  if (input.canHelm && !input.steeringBlocked) {
    patch.course = normalizeHeading(
      input.pending.course ?? input.orderedCourse,
    );
  }
  if (input.canEot && !input.propulsionDisabled) {
    patch.eot = input.pending.eot ?? input.standingEot;
  }
  if (input.canHelm && input.unitType === 'Submarine') {
    const pendingBlow =
      Boolean(input.pending.emergencyBlow) && input.pending.depth !== undefined;
    if (!input.divePlanesLocked || pendingBlow) {
      patch.depth = clampSubmarineDepth(
        input.pending.depth ??
          input.orderedDepth ??
          input.keelDepth ??
          0,
      );
      if (pendingBlow) patch.emergencyBlow = true;
    }
  }
  if (
    patch.course === undefined &&
    patch.eot === undefined &&
    patch.depth === undefined
  ) {
    return null;
  }
  return patch;
}

/** Compare standing-order content (ignore timestamps / writer metadata). */
export function ordersContentEqual(a: UnitOrders, b: UnitOrders): boolean {
  return ordersContentKey(a) === ordersContentKey(b);
}

function ordersContentKey(orders: UnitOrders): string {
  return JSON.stringify({
    course: orders.course,
    eot: orders.eot,
    depth: orders.depth,
    emergencyBlow: orders.emergencyBlow,
    fireTorpedo: orders.fireTorpedo ?? null,
    dropDepthCharges: orders.dropDepthCharges ?? null,
    fireDeckGun: orders.fireDeckGun ?? null,
    deployNoisemaker: orders.deployNoisemaker ?? null,
    aircraftAttack: orders.aircraftAttack ?? null,
    vesselStanding: orders.vesselStanding ?? null,
  });
}
