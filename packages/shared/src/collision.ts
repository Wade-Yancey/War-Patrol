/**
 * Hull-vs-hull contact during a resolve.
 *
 * Kinematics turns in place, then translates in a straight line. Each ship or
 * submarine is a capsule (bow–stern centerline, radius = beam/2). If those
 * capsules meet while the hulls share water, the move stops at contact, the
 * hulls are pushed apart, and closing speed becomes damage.
 *
 * A bow pointed at the other hull is a ram: the target takes more, the
 * ramming bow takes less. Head-on (both bows) splits the blow. Aircraft never
 * collide. A submarine strikes a surface ship only while shallow
 * ({@link COLLISION_DEPTH_BAND_M}); two submarines collide when their keels
 * are within that same band.
 */
import { KNOTS_TO_MPS } from './constants.js';
import { applyHealthDamageResult, formatCasualtySummary } from './damage.js';
import { resolveBeamM, resolveLengthM } from './dimensions.js';
import { clamp, displaceMeters, eastNorthMeters, normalizeHeading } from './geo.js';
import type { CombatLogEntry, LatLonDepth, UnitState, VesselType } from './types.js';
import { isHullLost } from './vessel.js';

/** Below this closing speed a touch is a scrape — no hull points. */
export const COLLISION_MIN_CLOSING_KN = 3;

/** Closing speed that maps to {@link COLLISION_REF_DAMAGE} before shape/mass. */
export const COLLISION_REF_CLOSING_KN = 16;

/** Base HP at the reference closing speed (equal mass, before bow shape). */
export const COLLISION_REF_DAMAGE = 26;

/** Hard cap so one impact cannot erase more than a fresh hull in one number. */
export const COLLISION_DAMAGE_CAP = 85;

/**
 * Travel heading within this many degrees of the bearing to the other center
 * counts as a bow ram (reinforced bow in, heavier blow out).
 */
export const RAM_BOW_CONE_DEG = 35;

/**
 * Vertical window (meters) for hull contact.
 * Ships always share the surface. A submarine meets a ship only at or above
 * this keel depth. Two submarines meet when |keel difference| is within it.
 * Periscope depth (~20 m) is below the band — a scope does not ram a hull.
 */
export const COLLISION_DEPTH_BAND_M = 8;

/** Along-track sample spacing. Kept under the narrowest combined beam. */
const SAMPLE_SPACING_M = 3;

const MAX_SAMPLES = 1600;

type V2 = { x: number; y: number };

interface Body {
  index: number;
  id: string;
  name: string;
  type: VesselType;
  heading: number;
  /** Signed knots along heading. Shed after a damaging hit; 0 after a stop for later contacts. */
  speed: number;
  lengthM: number;
  beamM: number;
  start: LatLonDepth;
  plannedEnd: LatLonDepth;
  /** Fraction of the planned move still taken (1 = full kinematics). */
  stopT: number;
  /** Nudge applied along the whole path (started the turn already overlapping). */
  pathOffE: number;
  pathOffN: number;
  /** Extra nudge applied from the stop point onward. */
  endOffE: number;
  endOffN: number;
}

export interface VesselCollisionResult {
  units: UnitState[];
  combatLogEntries: CombatLogEntry[];
}

function dot(a: V2, b: V2): number {
  return a.x * b.x + a.y * b.y;
}

function sub(a: V2, b: V2): V2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function add(a: V2, b: V2): V2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(a: V2, s: number): V2 {
  return { x: a.x * s, y: a.y * s };
}

function hypot2(a: V2): number {
  return Math.hypot(a.x, a.y);
}

/** Closest-point distance between two segments (Ericson). */
function segmentSegmentDistance(a0: V2, a1: V2, b0: V2, b1: V2): { distance: number; a: V2; b: V2 } {
  const d1 = sub(a1, a0);
  const d2 = sub(b1, b0);
  const r = sub(a0, b0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const eps = 1e-8;
  let s: number;
  let t: number;
  if (a <= eps && e <= eps) {
    s = 0;
    t = 0;
  } else if (a <= eps) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= eps) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > eps ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const ca = add(a0, scale(d1, s));
  const cb = add(b0, scale(d2, t));
  return { distance: hypot2(sub(ca, cb)), a: ca, b: cb };
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function displacementProxy(lengthM: number, beamM: number): number {
  return Math.max(1, lengthM) * Math.max(1, beamM);
}

/** True when two hulls are in the same water for contact. Aircraft never qualify. */
export function hullsShareWater(
  aType: VesselType,
  depthA: number,
  bType: VesselType,
  depthB: number,
): boolean {
  if (aType === 'Aircraft' || bType === 'Aircraft') return false;
  if (aType !== 'Ship' && aType !== 'Submarine') return false;
  if (bType !== 'Ship' && bType !== 'Submarine') return false;
  if (aType === 'Ship' && bType === 'Ship') return true;
  if (aType === 'Ship') return depthB <= COLLISION_DEPTH_BAND_M;
  if (bType === 'Ship') return depthA <= COLLISION_DEPTH_BAND_M;
  return Math.abs(depthA - depthB) <= COLLISION_DEPTH_BAND_M;
}

function angleBetween(a: number, b: number): number {
  let d = Math.abs(normalizeHeading(a) - normalizeHeading(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function travelHeading(heading: number, speedKn: number): number {
  return speedKn >= 0 ? normalizeHeading(heading) : normalizeHeading(heading + 180);
}

function velocityEn(heading: number, speedKn: number): V2 {
  const mps = speedKn * KNOTS_TO_MPS;
  const rad = (heading * Math.PI) / 180;
  return { x: Math.sin(rad) * mps, y: Math.cos(rad) * mps };
}

/**
 * Closing speed (knots) of A toward B. Positive when the range is shrinking.
 * Coincident centers fall back to relative speed so an embedded ram still counts.
 */
export function closingSpeedKn(velA: V2, velB: V2, fromA: V2, toB: V2): number {
  const dx = toB.x - fromA.x;
  const dy = toB.y - fromA.y;
  const mag = Math.hypot(dx, dy);
  const relx = velA.x - velB.x;
  const rely = velA.y - velB.y;
  if (mag < 0.5) return Math.hypot(relx, rely) / KNOTS_TO_MPS;
  return (relx * (dx / mag) + rely * (dy / mag)) / KNOTS_TO_MPS;
}

function isBowStrike(heading: number, speedKn: number, from: V2, to: V2): boolean {
  if (Math.abs(speedKn) < 0.5) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 0.5) return false;
  const bearing = normalizeHeading((Math.atan2(dx, dy) * 180) / Math.PI);
  return angleBetween(travelHeading(heading, speedKn), bearing) <= RAM_BOW_CONE_DEG;
}

/**
 * HP one hull takes from the other.
 * `strikerBow` is the hull dealing the blow; `targetBow` is the hull receiving it.
 */
export function collisionDamageHp(opts: {
  closingKn: number;
  strikerMass: number;
  targetMass: number;
  strikerBow: boolean;
  targetBow: boolean;
}): number {
  const closing = Math.max(0, opts.closingKn);
  if (closing < COLLISION_MIN_CLOSING_KN) return 0;
  const speedFactor = Math.pow(closing / COLLISION_REF_CLOSING_KN, 1.35);
  const base = COLLISION_REF_DAMAGE * speedFactor;
  const massScale = clamp(
    (opts.strikerMass + opts.targetMass) / (2 * Math.max(1, opts.targetMass)),
    0.35,
    2.6,
  );
  let shape = 0.7;
  if (opts.strikerBow && opts.targetBow) shape = 0.85;
  else if (opts.strikerBow && !opts.targetBow) shape = 1.45;
  else if (!opts.strikerBow && opts.targetBow) shape = 0.42;
  const raw = base * shape * massScale;
  if (raw < 1) return 0;
  return Math.round(Math.min(COLLISION_DAMAGE_CAP, raw));
}

function canCollide(unit: UnitState): boolean {
  if (unit.condition === 'sunk') return false;
  return unit.type === 'Ship' || unit.type === 'Submarine';
}

function samplePosition(body: Body, u: number): LatLonDepth {
  const t = clamp(u, 0, body.stopT);
  const base: LatLonDepth = {
    lat: body.start.lat + (body.plannedEnd.lat - body.start.lat) * t,
    lon: body.start.lon + (body.plannedEnd.lon - body.start.lon) * t,
    depth: body.start.depth + (body.plannedEnd.depth - body.start.depth) * t,
  };
  let pos = base;
  if (body.pathOffE !== 0 || body.pathOffN !== 0) {
    const shifted = displaceMeters(pos, body.pathOffE, body.pathOffN);
    pos = { ...shifted, depth: base.depth };
  }
  if (u >= body.stopT - 1e-8 && (body.endOffE !== 0 || body.endOffN !== 0)) {
    const shifted = displaceMeters(pos, body.endOffE, body.endOffN);
    pos = { ...shifted, depth: base.depth };
  }
  return pos;
}

function toPlane(origin: LatLonDepth, pos: LatLonDepth): V2 {
  const { east, north } = eastNorthMeters(origin, pos);
  return { x: east, y: north };
}

function centerline(origin: LatLonDepth, pos: LatLonDepth, heading: number, lengthM: number): {
  center: V2;
  bow: V2;
  stern: V2;
} {
  const center = toPlane(origin, pos);
  const rad = (heading * Math.PI) / 180;
  const fe = Math.sin(rad) * (lengthM / 2);
  const fn = Math.cos(rad) * (lengthM / 2);
  return {
    center,
    bow: { x: center.x + fe, y: center.y + fn },
    stern: { x: center.x - fe, y: center.y - fn },
  };
}

function capsuleHit(
  a: Body,
  b: Body,
  u: number,
  origin: LatLonDepth,
): { overlap: boolean; gap: number; from: V2; to: V2; centerA: V2; centerB: V2 } | null {
  const posA = samplePosition(a, u);
  const posB = samplePosition(b, u);
  if (!hullsShareWater(a.type, posA.depth, b.type, posB.depth)) return null;
  const lineA = centerline(origin, posA, a.heading, a.lengthM);
  const lineB = centerline(origin, posB, b.heading, b.lengthM);
  const reach = (a.lengthM + b.lengthM) / 2 + (a.beamM + b.beamM) / 2;
  if (hypot2(sub(lineA.center, lineB.center)) > reach) return null;
  const closest = segmentSegmentDistance(lineA.stern, lineA.bow, lineB.stern, lineB.bow);
  const limit = (a.beamM + b.beamM) / 2;
  return {
    overlap: closest.distance <= limit,
    gap: limit - closest.distance,
    from: closest.a,
    to: closest.b,
    centerA: lineA.center,
    centerB: lineB.center,
  };
}

function capsulesOverlap(a: Body, b: Body, u: number, origin: LatLonDepth): boolean {
  return capsuleHit(a, b, u, origin)?.overlap ?? false;
}

function stepsFor(a: Body, b: Body): number {
  const distA = hypot2(sub(toPlane(a.start, a.plannedEnd), { x: 0, y: 0 }));
  const distB = hypot2(sub(toPlane(b.start, b.plannedEnd), { x: 0, y: 0 }));
  // toPlane(a.start, plannedEnd) uses a.start as origin — correct local distance.
  const dist = Math.max(distA, distB);
  return Math.min(MAX_SAMPLES, Math.max(16, Math.ceil(dist / SAMPLE_SPACING_M)));
}

function earliestContact(a: Body, b: Body, origin: LatLonDepth): number | null {
  const n = stepsFor(a, b);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    if (!capsulesOverlap(a, b, u, origin)) continue;
    if (i === 0) return 0;
    let lo = (i - 1) / n;
    let hi = u;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      if (capsulesOverlap(a, b, mid, origin)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return null;
}

function speedAt(body: Body, u: number): number {
  if (u > body.stopT + 1e-6) return 0;
  return body.speed;
}

function shedSpeed(speed: number, closingKn: number): number {
  const frac = clamp(closingKn / 42, 0.25, 0.8);
  const next = speed * (1 - frac);
  return Math.abs(next) < 0.4 ? 0 : next;
}

function pushApart(
  a: Body,
  b: Body,
  hit: { gap: number; from: V2; to: V2; centerA: V2; centerB: V2 },
  atStop: boolean,
): void {
  let nx = hit.to.x - hit.from.x;
  let ny = hit.to.y - hit.from.y;
  let mag = Math.hypot(nx, ny);
  if (mag < 0.25) {
    nx = hit.centerB.x - hit.centerA.x;
    ny = hit.centerB.y - hit.centerA.y;
    mag = Math.hypot(nx, ny);
  }
  if (mag < 0.25) {
    const rad = (a.heading * Math.PI) / 180;
    nx = Math.sin(rad);
    ny = Math.cos(rad);
    mag = 1;
  }
  nx /= mag;
  ny /= mag;
  const push = Math.max(0, hit.gap) / 2 + 1.25;
  if (atStop) {
    a.endOffE -= nx * push;
    a.endOffN -= ny * push;
    b.endOffE += nx * push;
    b.endOffN += ny * push;
  } else {
    a.pathOffE -= nx * push;
    a.pathOffN -= ny * push;
    b.pathOffE += nx * push;
    b.pathOffN += ny * push;
  }
}

function contactSummary(opts: {
  nameA: string;
  nameB: string;
  targetName: string;
  damage: number;
  closingKn: number;
  bowA: boolean;
  bowB: boolean;
}): string {
  const kn = Math.round(opts.closingKn);
  const hp = `${opts.targetName} −${opts.damage} HP (${kn} kn)`;
  if (opts.bowA && opts.bowB) return `${opts.nameA} and ${opts.nameB} HEAD-ON RAM — ${hp}`;
  if (opts.bowA) return `${opts.nameA} RAMMED ${opts.nameB} — ${hp}`;
  if (opts.bowB) return `${opts.nameB} RAMMED ${opts.nameA} — ${hp}`;
  return `${opts.nameA} collided with ${opts.nameB} — ${hp}`;
}

/**
 * Resolve pairwise hull contact for one turn.
 * `startPositions` are pre-kinematics plots; `units` are post-kinematics.
 * Fully sunk hulls and aircraft are ignored. A sinking hull is still a hulk.
 */
export function resolveVesselCollisions(
  units: UnitState[],
  startPositions: ReadonlyMap<string, LatLonDepth>,
  opts: { turnNumber: number; gameTimeSeconds: number; nowIso?: string },
): VesselCollisionResult {
  const at = opts.nowIso ?? new Date().toISOString();
  const working = units.map((unit) => ({ ...unit, position: { ...unit.position } }));
  const byId = new Map(working.map((unit) => [unit.id, unit]));
  const origin = working[0]?.position ?? { lat: 0, lon: 0, depth: 0 };

  const bodies: Body[] = [];
  for (const unit of working) {
    if (!canCollide(unit)) continue;
    const start = startPositions.get(unit.id) ?? unit.position;
    const { lengthM, beamM } = {
      lengthM: resolveLengthM({ lengthM: unit.lengthM, class: unit.class, type: unit.type }),
      beamM: resolveBeamM({ beamM: unit.beamM, class: unit.class, type: unit.type }),
    };
    bodies.push({
      index: working.indexOf(unit),
      id: unit.id,
      name: unit.name,
      type: unit.type,
      heading: unit.heading,
      speed: unit.speed,
      lengthM,
      beamM,
      start: { ...start },
      plannedEnd: { ...unit.position },
      stopT: 1,
      pathOffE: 0,
      pathOffN: 0,
      endOffE: 0,
      endOffN: 0,
    });
  }

  const combatLogEntries: CombatLogEntry[] = [];
  const resolved = new Set<string>();
  const softTries = new Map<string, number>();
  const maxIter = bodies.length * bodies.length + 8;

  const commit = (body: Body, unit: UnitState) => {
    working[body.index] = unit;
    byId.set(unit.id, unit);
  };

  const writePose = (body: Body) => {
    const unit = byId.get(body.id);
    if (!unit) return;
    const next: UnitState = {
      ...unit,
      position: samplePosition(body, 1),
      speed: isHullLost(unit.condition) ? unit.speed : body.speed,
    };
    commit(body, next);
  };

  for (let iter = 0; iter < maxIter; iter++) {
    let best: { a: Body; b: Body; t: number; key: string } | null = null;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const key = pairKey(a.id, b.id);
        if (resolved.has(key)) continue;
        const t = earliestContact(a, b, origin);
        if (t == null) continue;
        if (
          !best ||
          t < best.t - 1e-6 ||
          (Math.abs(t - best.t) <= 1e-6 && key < best.key)
        ) {
          best = { a, b, t, key };
        }
      }
    }
    if (!best) break;

    const { a, b, t, key } = best;
    const hit = capsuleHit(a, b, t, origin);
    if (!hit?.overlap) {
      resolved.add(key);
      continue;
    }

    const velA = velocityEn(a.heading, speedAt(a, t));
    const velB = velocityEn(b.heading, speedAt(b, t));
    const closing = Math.max(0, closingSpeedKn(velA, velB, hit.centerA, hit.centerB));
    const startedInside = t <= 1e-4;

    if (startedInside && closing < COLLISION_MIN_CLOSING_KN) {
      const tries = (softTries.get(key) ?? 0) + 1;
      softTries.set(key, tries);
      pushApart(a, b, hit, false);
      writePose(a);
      writePose(b);
      if (tries >= 4 || !capsulesOverlap(a, b, 0, origin)) {
        // Clear of the start overlap. A later crossing can still be found
        // unless we gave up after repeated nudges.
        if (tries >= 4) resolved.add(key);
      }
      continue;
    }

    resolved.add(key);
    a.stopT = Math.min(a.stopT, t);
    b.stopT = Math.min(b.stopT, t);
    pushApart(a, b, hit, true);

    const bowA = isBowStrike(a.heading, speedAt(a, t), hit.centerA, hit.centerB);
    const bowB = isBowStrike(b.heading, speedAt(b, t), hit.centerB, hit.centerA);
    const massA = displacementProxy(a.lengthM, a.beamM);
    const massB = displacementProxy(b.lengthM, b.beamM);
    if (closing >= COLLISION_MIN_CLOSING_KN) {
      a.speed = shedSpeed(speedAt(a, t), closing);
      b.speed = shedSpeed(speedAt(b, t), closing);
    }

    const dmgA = collisionDamageHp({
      closingKn: closing,
      strikerMass: massB,
      targetMass: massA,
      strikerBow: bowB,
      targetBow: bowA,
    });
    const dmgB = collisionDamageHp({
      closingKn: closing,
      strikerMass: massA,
      targetMass: massB,
      strikerBow: bowA,
      targetBow: bowB,
    });

    applyHit(a, b, dmgA, closing, bowA, bowB, byId, commit, combatLogEntries, opts, at);
    applyHit(b, a, dmgB, closing, bowB, bowA, byId, commit, combatLogEntries, opts, at);
    writePose(a);
    writePose(b);
  }

  for (const body of bodies) writePose(body);

  return { units: working, combatLogEntries };
}

function applyHit(
  targetBody: Body,
  otherBody: Body,
  damage: number,
  closing: number,
  bowTarget: boolean,
  bowOther: boolean,
  byId: Map<string, UnitState>,
  commit: (body: Body, unit: UnitState) => void,
  combatLogEntries: CombatLogEntry[],
  opts: { turnNumber: number; gameTimeSeconds: number },
  at: string,
): void {
  const target = byId.get(targetBody.id);
  const other = byId.get(otherBody.id);
  if (!target || !other || damage <= 0) return;
  if (isHullLost(target.condition)) return;

  const before = target.condition;
  const rng = mulberry32(hashSeed(`${opts.turnNumber}|${other.id}|${target.id}|hit`));
  const { unit: damaged, effects } = applyHealthDamageResult(
    { ...target, speed: targetBody.speed },
    damage,
    rng,
  );
  const applied = Math.max(0, target.health - damaged.health);
  commit(targetBody, damaged);
  targetBody.speed = damaged.speed;

  if (applied <= 0) return;

  // Names and bow flags follow id order so both lines share one "A RAMMED B" clause.
  const targetIsLower = targetBody.id < otherBody.id;
  const nameA = targetIsLower ? target.name : other.name;
  const nameB = targetIsLower ? other.name : target.name;
  const bowA = targetIsLower ? bowTarget : bowOther;
  const bowB = targetIsLower ? bowOther : bowTarget;
  const idA = targetIsLower ? target.id : other.id;
  const idB = targetIsLower ? other.id : target.id;

  combatLogEntries.push({
    id: `cl-collision-${idA}-${idB}-t${opts.turnNumber}-${target.id}`,
    kind: 'collision',
    turnNumber: opts.turnNumber,
    gameTimeSeconds: opts.gameTimeSeconds,
    at,
    summary: contactSummary({
      nameA,
      nameB,
      targetName: target.name,
      damage: applied,
      closingKn: closing,
      bowA,
      bowB,
    }),
    actorUnitId: other.id,
    actorName: other.name,
    targetUnitId: target.id,
    targetName: target.name,
    damage: applied,
  });

  for (let i = 0; i < effects.length; i++) {
    const effect = effects[i]!;
    combatLogEntries.push({
      id: `cl-collision-cas-${target.id}-${effect.kind}-${i}-t${opts.turnNumber}`,
      kind: 'subsystem_casualty',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      at,
      summary: formatCasualtySummary(target.name, effect),
      actorUnitId: other.id,
      actorName: other.name,
      targetUnitId: target.id,
      targetName: target.name,
      casualtyEffect: effect,
    });
  }

  if ((damaged.condition === 'sinking' || damaged.condition === 'sunk') && before === 'afloat') {
    combatLogEntries.push({
      id: `cl-collision-sunk-${target.id}-t${opts.turnNumber}`,
      kind: 'unit_sunk',
      turnNumber: opts.turnNumber,
      gameTimeSeconds: opts.gameTimeSeconds,
      at,
      summary: `${damaged.name} SUNK / destroyed`,
      actorUnitId: other.id,
      actorName: other.name,
      targetUnitId: damaged.id,
      targetName: damaged.name,
    });
  }
}
