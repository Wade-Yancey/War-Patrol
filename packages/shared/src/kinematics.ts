import { KNOTS_TO_MPS } from './constants.js';
import {
  clampSubmarineDepth,
  stepDepthTowardOrdered,
} from './dive.js';
import { targetSpeedForUnit } from './eot.js';
import { clamp, moveAlongHeading, normalizeHeading } from './geo.js';
import {
  clampSpeedToMax,
  effectiveMaxSpeed,
  resolveSpeedStepFraction,
  stepSpeedTowardTarget,
} from './performance.js';
import type { LatLonDepth, UnitOrders, UnitState } from './types.js';
import {
  divePlanesBlockDepthOrders,
  ensureSubsystemLocks,
  propulsionSpeedFactor,
  resolveSubsystems,
} from './damage.js';
import {
  canMakeWay,
  normalizePositionForType,
  resolveOrderedDepth,
} from './vessel.js';
import { applyAircraftStandingOrders } from './aircraft.js';
import { applyVesselStandingOrders } from './vesselStanding.js';
/** Shortest-arc heading step toward desired, capped by maxDelta degrees. */
export function turnToward(current: number, desired: number, maxDelta: number): number {
  const cur = normalizeHeading(current);
  const des = normalizeHeading(desired);
  let delta = des - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  const applied = clamp(delta, -maxDelta, maxDelta);
  return normalizeHeading(cur + applied);
}

function preserveWeaponOrders(orders: UnitOrders): UnitOrders {
  const next: UnitOrders = {};
  if (orders.fireTorpedo) next.fireTorpedo = { ...orders.fireTorpedo };
  if (orders.dropDepthCharges) next.dropDepthCharges = { ...orders.dropDepthCharges };
  if (orders.fireDeckGun) next.fireDeckGun = { ...orders.fireDeckGun };
  if (orders.aircraftAttack) next.aircraftAttack = { ...orders.aircraftAttack };
  if (orders.vesselStanding) next.vesselStanding = { ...orders.vesselStanding };
  return next;
}

/**
 * Apply helm / EOT / depth kinematics for one resolve (same math as turnEngine).
 * When `clearOrders` is false, weapon order fields are preserved for launch.
 */
export function applyUnitKinematics(
  unit: UnitState,
  turnLengthSeconds: number,
  clearOrders = true,
): UnitState {
  // Sunk / destroyed or dead propulsion: no way — clear motion, ignore orders kinematics.
  if (!canMakeWay(unit)) {
    return {
      ...unit,
      speed: 0,
      eot: 'stop',
      orders: clearOrders ? {} : preserveWeaponOrders(unit.orders),
    };
  }

  const orders = unit.orders;
  let subsystems = ensureSubsystemLocks(unit.subsystems, unit);
  let orderedCourse =
    typeof unit.orderedCourse === 'number' ? unit.orderedCourse : unit.heading;
  let orderedDepth = resolveOrderedDepth(unit.type, unit.position.depth, unit.orderedDepth);
  let heading = unit.heading;
  let eot = unit.eot;
  let speed = unit.speed;
  let position = { ...unit.position };

  // Rudder stuck: helm set-point frozen; ignore new course orders.
  // Steering disabled: course may update but yaw is blocked below.
  if (subsystems.steering === 'stuck') {
    orderedCourse = normalizeHeading(
      subsystems.rudderStuckHeading ?? orderedCourse,
    );
  } else if (orders.course !== undefined) {
    // Helm order updates the persistent steering course immediately for this resolve.
    orderedCourse = normalizeHeading(orders.course);
  }

  // Dive planes stuck/disabled: depth set-point frozen — except Emergency Blow
  // (ballast blow), which may still order surface and retarget the jam to 0 m.
  const emergencyBlow =
    unit.type === 'Submarine' &&
    Boolean(orders.emergencyBlow) &&
    orders.depth !== undefined;
  const diveLocked =
    unit.type === 'Submarine' && divePlanesBlockDepthOrders(subsystems);
  if (diveLocked && !emergencyBlow) {
    orderedDepth = clampSubmarineDepth(
      subsystems.divePlanesStuckDepth ?? orderedDepth,
    );
  } else if (orders.depth !== undefined && unit.type === 'Submarine') {
    // Depth order updates the standing set-point; keel depth steps toward it this resolve.
    orderedDepth = clampSubmarineDepth(orders.depth);
    if (emergencyBlow && diveLocked) {
      // Keep planes jammed/disabled, but freeze at surface so the next resolve
      // does not pull the boat back down to the old stuck depth.
      subsystems = resolveSubsystems({
        ...subsystems,
        divePlanesStuckDepth: 0,
      });
    }
  }
  if (unit.type === 'Submarine') {
    const nextDepth = stepDepthTowardOrdered(
      position.depth,
      orderedDepth,
      turnLengthSeconds,
    );
    position = { ...position, depth: nextDepth };
  } else {
    orderedDepth = 0;
    position = normalizePositionForType(unit.type, position);
  }

  // Turn toward ordered course (size-based turnRate deg/min × in-game minutes).
  // Steering disabled → no yaw this resolve.
  if (subsystems.steering !== 'disabled') {
    const maxDelta = unit.turnRate * (turnLengthSeconds / 60);
    heading = turnToward(heading, orderedCourse, maxDelta);
  }

  if (orders.eot !== undefined) {
    eot = orders.eot;
  }

  // Submarines deeper than surface band use submerged max (~9 kn), not hull maxSpeed.
  // Use post-dive depth so a dive+move in the same resolve uses submerged ceiling.
  // Damaged propulsion halves the effective ceiling.
  const speedCeiling =
    effectiveMaxSpeed({
      type: unit.type,
      maxSpeed: unit.maxSpeed,
      depth: position.depth,
    }) * propulsionSpeedFactor(subsystems.propulsion);
  // Ships/subs: signed EOT target. Aircraft: loiter/cruise/full (never reverse).
  const target = targetSpeedForUnit(unit.type, eot, speedCeiling);
  // Speed steps toward target (class-scaled fraction of effective max per resolve).
  // Momentum: cannot cross through zero in one resolve (ships/subs reverse via stop).
  const step =
    speedCeiling * resolveSpeedStepFraction({ class: unit.class, type: unit.type });
  speed = stepSpeedTowardTarget(speed, target, step);
  if (unit.type === 'Aircraft') {
    // Aircraft never make sternway; clamp any legacy negative speed to ≥ 0.
    speed = Math.max(0, speed);
  }
  speed = clampSpeedToMax(speed, speedCeiling);

  const distance = Math.abs(speed) * KNOTS_TO_MPS * turnLengthSeconds;
  const moveHeading = speed >= 0 ? heading : normalizeHeading(heading + 180);
  position = distance > 0 ? moveAlongHeading(position, moveHeading, distance) : position;

  const nextOrders = clearOrders ? {} : preserveWeaponOrders(orders);

  return {
    ...unit,
    heading: normalizeHeading(heading),
    orderedCourse: normalizeHeading(orderedCourse),
    orderedDepth,
    eot,
    speed,
    position,
    subsystems,
    orders: nextOrders,
  };
}

/**
 * End-of-turn lat/lon track for umpire GT move prediction.
 * Matches resolveTurn: standing aircraft attack / loiter and vessel standing
 * orders inject course (+ band/preferred EOT) before helm/EOT kinematics, then
 * one move segment along the final heading.
 *
 * Pass `allUnits` (the live GT roster) so parent-centered loiter, attack target
 * plots, and vessel standing targets resolve the same way as turnEngine. When
 * omitted, only the single unit is prepared. Returns null when the unit makes
 * no way this resolve (sunk / dead propulsion / stop).
 */
export function predictUnitMovePath(
  unit: UnitState,
  turnLengthSeconds: number,
  allUnits?: readonly UnitState[],
): { lat: number; lon: number }[] | null {
  if (!canMakeWay(unit)) return null;
  // Same pre-kinematics standing-order injection as turnEngine.resolveTurn.
  let prepared = unit;
  const hasAircraftStanding =
    unit.type === 'Aircraft' &&
    (Boolean(unit.aircraftLoiter) || Boolean(unit.orders.aircraftAttack));
  const hasVesselStanding =
    (unit.type === 'Ship' || unit.type === 'Submarine') &&
    Boolean(unit.orders.vesselStanding);
  if (hasAircraftStanding || hasVesselStanding) {
    const peers = allUnits
      ? allUnits.some((u) => u.id === unit.id)
        ? [...allUnits]
        : [...allUnits, unit]
      : [unit];
    const afterAircraft = hasAircraftStanding
      ? applyAircraftStandingOrders(peers)
      : peers;
    const afterVessel = hasVesselStanding
      ? applyVesselStandingOrders(afterAircraft)
      : afterAircraft;
    prepared = afterVessel.find((u) => u.id === unit.id) ?? unit;
  }
  const start: LatLonDepth = { ...prepared.position };
  const end = applyUnitKinematics(prepared, turnLengthSeconds, false).position;
  const dLat = end.lat - start.lat;
  const dLon = end.lon - start.lon;
  // Skip zero-length tracks (stopped / no distance this turn).
  if (Math.hypot(dLat, dLon) < 1e-9) return null;
  return [
    { lat: start.lat, lon: start.lon },
    { lat: end.lat, lon: end.lon },
  ];
}
