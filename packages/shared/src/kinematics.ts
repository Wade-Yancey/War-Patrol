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
  canMakeWay,
  normalizePositionForType,
  resolveOrderedDepth,
} from './vessel.js';

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
  let orderedCourse =
    typeof unit.orderedCourse === 'number' ? unit.orderedCourse : unit.heading;
  let orderedDepth = resolveOrderedDepth(unit.type, unit.position.depth, unit.orderedDepth);
  let heading = unit.heading;
  let eot = unit.eot;
  let speed = unit.speed;
  let position = { ...unit.position };

  // Helm order updates the persistent steering course immediately for this resolve.
  if (orders.course !== undefined) {
    orderedCourse = normalizeHeading(orders.course);
  }

  // Depth order updates the standing set-point; keel depth steps toward it this resolve.
  if (orders.depth !== undefined && unit.type === 'Submarine') {
    orderedDepth = clampSubmarineDepth(orders.depth);
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
  const maxDelta = unit.turnRate * (turnLengthSeconds / 60);
  heading = turnToward(heading, orderedCourse, maxDelta);

  if (orders.eot !== undefined) {
    eot = orders.eot;
  }

  // Submarines deeper than surface band use submerged max (~9 kn), not hull maxSpeed.
  // Use post-dive depth so a dive+move in the same resolve uses submerged ceiling.
  const speedCeiling = effectiveMaxSpeed({
    type: unit.type,
    maxSpeed: unit.maxSpeed,
    depth: position.depth,
  });
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
    orders: nextOrders,
  };
}

/**
 * End-of-turn lat/lon track for umpire GT move prediction.
 * Matches resolve: turn + EOT speed step, then one move segment along final heading.
 * Returns null when the unit makes no way this resolve (sunk / dead propulsion / stop).
 */
export function predictUnitMovePath(
  unit: UnitState,
  turnLengthSeconds: number,
): { lat: number; lon: number }[] | null {
  if (!canMakeWay(unit)) return null;
  const start: LatLonDepth = { ...unit.position };
  const end = applyUnitKinematics(unit, turnLengthSeconds, false).position;
  const dLat = end.lat - start.lat;
  const dLon = end.lon - start.lon;
  // Skip zero-length tracks (stopped / no distance this turn).
  if (Math.hypot(dLat, dLon) < 1e-9) return null;
  return [
    { lat: start.lat, lon: start.lon },
    { lat: end.lat, lon: end.lon },
  ];
}
