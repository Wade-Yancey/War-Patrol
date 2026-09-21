/**
 * Granular combat casualty model — propulsion / per-station sensors /
 * steering / dive planes. See docs/simulation-physics.md (project store).
 */
import { normalizeHeading } from './geo.js';
import type {
  CasualtyEffect,
  CasualtyEffectKind,
  DivePlanesState,
  PropulsionState,
  SensorKind,
  SteeringState,
  SubsystemState,
  UnitState,
  UnitSubsystems,
} from './types.js';

function hasSensorKind(
  unit: Pick<UnitState, 'sensors'>,
  kind: SensorKind,
): boolean {
  return Boolean(unit.sensors?.some((s) => s.kind === kind));
}

/** Health below this → eligible for per-station sensor knockout rolls. */
export const HEALTH_SENSORS_CASUALTY_BELOW = 70;

/** @deprecated Alias — prefer {@link HEALTH_SENSORS_CASUALTY_BELOW}. */
export const HEALTH_SENSORS_DISABLED_BELOW = HEALTH_SENSORS_CASUALTY_BELOW;

/** Health below this → eligible for steering / dive-plane casualty rolls. */
export const HEALTH_CONTROL_CASUALTY_BELOW = 55;

/** Health below this → eligible for propulsion damaged / disabled rolls. */
export const HEALTH_PROPULSION_CASUALTY_BELOW = 35;

/** @deprecated Alias — prefer {@link HEALTH_PROPULSION_CASUALTY_BELOW}. */
export const HEALTH_PROPULSION_DISABLED_BELOW = HEALTH_PROPULSION_CASUALTY_BELOW;

/** Max-speed multiplier when propulsion is `damaged` (not fully knocked out). */
export const PROPULSION_DAMAGED_SPEED_FACTOR = 0.5;

/** Per intact installed sensor station, when HP &lt; sensors band (each damaging hit). */
export const CASUALTY_P_SENSOR_STATION = 0.4;

/** Rudder jammed (stuck) when HP &lt; control band and steering still intact. */
export const CASUALTY_P_RUDDER_STUCK = 0.22;

/** Steering gear outright disabled (no yaw) when HP &lt; control band. */
export const CASUALTY_P_STEERING_DISABLED = 0.12;

/** Dive planes jammed (subs only) when HP &lt; control band. */
export const CASUALTY_P_DIVE_PLANES_STUCK = 0.28;

/** Propulsion reduced (damaged) when intact and HP &lt; propulsion band. */
export const CASUALTY_P_PROPULSION_DAMAGED = 0.5;

/** Propulsion full knockout when intact and HP &lt; propulsion band. */
export const CASUALTY_P_PROPULSION_DISABLED = 0.28;

/** Escalate damaged → disabled when already damaged and HP &lt; propulsion band. */
export const CASUALTY_P_PROPULSION_ESCALATE = 0.35;

export const PROPULSION_STATES = ['intact', 'damaged', 'disabled'] as const;
export const SUBSYSTEM_STATES = ['intact', 'disabled'] as const;
export const STEERING_STATES = ['intact', 'disabled', 'stuck'] as const;
export const DIVE_PLANES_STATES = ['intact', 'stuck', 'disabled'] as const;

export function defaultSubsystems(): UnitSubsystems {
  return {
    propulsion: 'intact',
    radar: 'intact',
    hydrophone: 'intact',
    activeSonar: 'intact',
    lookout: 'intact',
    steering: 'intact',
    divePlanes: 'intact',
  };
}

function parseBinary(value: unknown): SubsystemState {
  return value === 'disabled' ? 'disabled' : 'intact';
}

function parsePropulsion(value: unknown): PropulsionState {
  if (value === 'disabled' || value === 'damaged') return value;
  return 'intact';
}

function parseSteering(value: unknown): SteeringState {
  if (value === 'disabled' || value === 'stuck') return value;
  return 'intact';
}

function parseDivePlanes(value: unknown): DivePlanesState {
  if (value === 'disabled' || value === 'stuck') return value;
  return 'intact';
}

/**
 * Normalize / migrate subsystem blobs from saves and umpire patches.
 * Legacy `{ sensors: 'disabled' }` expands to all sensor stations disabled.
 */
export function resolveSubsystems(
  partial?: Partial<UnitSubsystems> & { sensors?: SubsystemState } | null,
): UnitSubsystems {
  const d = defaultSubsystems();
  if (!partial) return d;

  const legacyAllSensorsOut = partial.sensors === 'disabled';
  const next: UnitSubsystems = {
    propulsion: parsePropulsion(partial.propulsion ?? d.propulsion),
    radar: parseBinary(partial.radar ?? (legacyAllSensorsOut ? 'disabled' : d.radar)),
    hydrophone: parseBinary(
      partial.hydrophone ?? (legacyAllSensorsOut ? 'disabled' : d.hydrophone),
    ),
    activeSonar: parseBinary(
      partial.activeSonar ?? (legacyAllSensorsOut ? 'disabled' : d.activeSonar),
    ),
    lookout: parseBinary(partial.lookout ?? (legacyAllSensorsOut ? 'disabled' : d.lookout)),
    steering: parseSteering(partial.steering ?? d.steering),
    divePlanes: parseDivePlanes(partial.divePlanes ?? d.divePlanes),
  };

  if (next.steering === 'stuck') {
    const h = partial.rudderStuckHeading;
    if (typeof h === 'number' && Number.isFinite(h)) {
      next.rudderStuckHeading = normalizeHeading(h);
    }
  }
  if (next.divePlanes === 'stuck' || next.divePlanes === 'disabled') {
    const depth = partial.divePlanesStuckDepth;
    if (typeof depth === 'number' && Number.isFinite(depth)) {
      next.divePlanesStuckDepth = Math.max(0, depth);
    }
  }

  return next;
}

/** True when every damageable sensor station on this hull is offline. */
export function allSensorsDisabled(unit: Pick<UnitState, 'subsystems' | 'sensors' | 'type'>): boolean {
  const s = resolveSubsystems(unit.subsystems);
  const checks: boolean[] = [];
  if (hasSensorKind(unit, 'radar')) checks.push(s.radar === 'disabled');
  if (hasSensorKind(unit, 'hydrophone')) checks.push(s.hydrophone === 'disabled');
  if (hasSensorKind(unit, 'active_sonar')) checks.push(s.activeSonar === 'disabled');
  // Ship bridge lookout is immune — do not count toward “all sensors out.”
  if (unit.type === 'Submarine' && hasSensorKind(unit, 'lookout')) {
    checks.push(s.lookout === 'disabled');
  }
  if (checks.length === 0) return false;
  return checks.every(Boolean);
}

export function isSensorStationDisabled(
  subsystems: UnitSubsystems | undefined,
  kind: 'radar' | 'hydrophone' | 'active_sonar' | 'lookout',
): boolean {
  const s = resolveSubsystems(subsystems);
  switch (kind) {
    case 'radar':
      return s.radar === 'disabled';
    case 'hydrophone':
      return s.hydrophone === 'disabled';
    case 'active_sonar':
      return s.activeSonar === 'disabled';
    case 'lookout':
      return s.lookout === 'disabled';
  }
}

export type SensorUseResult = { ok: boolean; reason?: 'sunk' | 'sensors_disabled' };

/**
 * Own-ship sensor set usable (not sunk, that station not knocked out).
 * Ship bridge lookout is immune to lookout-station combat damage.
 */
export function canUseSensorStation(
  unit: Pick<UnitState, 'condition' | 'subsystems' | 'type'>,
  kind: 'radar' | 'hydrophone' | 'active_sonar' | 'lookout',
): SensorUseResult {
  if (unit.condition === 'sunk') return { ok: false, reason: 'sunk' };
  if (kind === 'lookout' && unit.type === 'Ship') return { ok: true };
  if (isSensorStationDisabled(unit.subsystems, kind)) {
    return { ok: false, reason: 'sensors_disabled' };
  }
  return { ok: true };
}

/** @deprecated Prefer {@link canUseSensorStation} with an explicit kind. */
export function canUseSensors(
  unit: Pick<UnitState, 'condition' | 'subsystems' | 'type'>,
): SensorUseResult {
  return canUseSensorStation(unit, 'radar');
}

export function propulsionSpeedFactor(propulsion: PropulsionState | undefined): number {
  if (propulsion === 'disabled') return 0;
  if (propulsion === 'damaged') return PROPULSION_DAMAGED_SPEED_FACTOR;
  return 1;
}

export function casualtyEffectLabel(kind: CasualtyEffectKind): string {
  switch (kind) {
    case 'propulsion_damaged':
      return 'propulsion damaged (reduced speed)';
    case 'propulsion_disabled':
      return 'propulsion disabled';
    case 'radar_disabled':
      return 'radar knocked out';
    case 'hydrophone_disabled':
      return 'hydrophone knocked out';
    case 'active_sonar_disabled':
      return 'active sonar knocked out';
    case 'lookout_disabled':
      return 'periscope / lookout knocked out';
    case 'steering_disabled':
      return 'steering disabled';
    case 'rudder_stuck':
      return 'rudder stuck';
    case 'dive_planes_stuck':
      return 'dive planes stuck';
    case 'dive_planes_disabled':
      return 'dive planes disabled';
  }
}

export function formatCasualtySummary(unitName: string, effect: CasualtyEffect): string {
  const base = `${unitName}: ${casualtyEffectLabel(effect.kind)}`;
  if (effect.kind === 'rudder_stuck' && effect.stuckHeading != null) {
    return `${base} at ${String(Math.round(effect.stuckHeading)).padStart(3, '0')}°`;
  }
  if (
    (effect.kind === 'dive_planes_stuck' || effect.kind === 'dive_planes_disabled') &&
    effect.stuckDepthM != null
  ) {
    return `${base} at ${Math.round(effect.stuckDepthM)} m`;
  }
  return base;
}

export type CasualtyRollResult = {
  subsystems: UnitSubsystems;
  effects: CasualtyEffect[];
};

function pushEffect(effects: CasualtyEffect[], effect: CasualtyEffect): void {
  effects.push(effect);
}

/**
 * Roll granular casualties for one damaging hit given post-hit health.
 * Never heals; only applies new / escalating effects. Injectable RNG for tests.
 */
export function rollCombatCasualties(
  unit: UnitState,
  healthAfter: number,
  rng: () => number = Math.random,
): CasualtyRollResult {
  const subsystems = resolveSubsystems({ ...unit.subsystems });
  const effects: CasualtyEffect[] = [];

  if (healthAfter < HEALTH_SENSORS_CASUALTY_BELOW) {
    if (hasSensorKind(unit, 'radar') && subsystems.radar === 'intact' && rng() < CASUALTY_P_SENSOR_STATION) {
      subsystems.radar = 'disabled';
      pushEffect(effects, { kind: 'radar_disabled' });
    }
    if (
      hasSensorKind(unit, 'hydrophone') &&
      subsystems.hydrophone === 'intact' &&
      rng() < CASUALTY_P_SENSOR_STATION
    ) {
      subsystems.hydrophone = 'disabled';
      pushEffect(effects, { kind: 'hydrophone_disabled' });
    }
    if (
      hasSensorKind(unit, 'active_sonar') &&
      subsystems.activeSonar === 'intact' &&
      rng() < CASUALTY_P_SENSOR_STATION
    ) {
      subsystems.activeSonar = 'disabled';
      pushEffect(effects, { kind: 'active_sonar_disabled' });
    }
    // Fleet-sub periscope only — DD bridge lookout is immune.
    if (
      unit.type === 'Submarine' &&
      hasSensorKind(unit, 'lookout') &&
      subsystems.lookout === 'intact' &&
      rng() < CASUALTY_P_SENSOR_STATION
    ) {
      subsystems.lookout = 'disabled';
      pushEffect(effects, { kind: 'lookout_disabled' });
    }
  }

  if (healthAfter < HEALTH_CONTROL_CASUALTY_BELOW && subsystems.steering === 'intact') {
    const r = rng();
    if (r < CASUALTY_P_STEERING_DISABLED) {
      subsystems.steering = 'disabled';
      delete subsystems.rudderStuckHeading;
      pushEffect(effects, { kind: 'steering_disabled' });
    } else if (r < CASUALTY_P_STEERING_DISABLED + CASUALTY_P_RUDDER_STUCK) {
      const stuckHeading = normalizeHeading(
        typeof unit.orderedCourse === 'number' ? unit.orderedCourse : unit.heading,
      );
      subsystems.steering = 'stuck';
      subsystems.rudderStuckHeading = stuckHeading;
      pushEffect(effects, { kind: 'rudder_stuck', stuckHeading });
    }
  }

  if (
    unit.type === 'Submarine' &&
    healthAfter < HEALTH_CONTROL_CASUALTY_BELOW &&
    subsystems.divePlanes === 'intact' &&
    rng() < CASUALTY_P_DIVE_PLANES_STUCK
  ) {
    const stuckDepthM =
      typeof unit.orderedDepth === 'number' && Number.isFinite(unit.orderedDepth)
        ? unit.orderedDepth
        : unit.position.depth;
    subsystems.divePlanes = 'stuck';
    subsystems.divePlanesStuckDepth = stuckDepthM;
    pushEffect(effects, { kind: 'dive_planes_stuck', stuckDepthM });
  }

  if (healthAfter < HEALTH_PROPULSION_CASUALTY_BELOW) {
    if (subsystems.propulsion === 'intact') {
      const r = rng();
      if (r < CASUALTY_P_PROPULSION_DISABLED) {
        subsystems.propulsion = 'disabled';
        pushEffect(effects, { kind: 'propulsion_disabled' });
      } else if (r < CASUALTY_P_PROPULSION_DISABLED + CASUALTY_P_PROPULSION_DAMAGED) {
        subsystems.propulsion = 'damaged';
        pushEffect(effects, { kind: 'propulsion_damaged' });
      }
    } else if (
      subsystems.propulsion === 'damaged' &&
      rng() < CASUALTY_P_PROPULSION_ESCALATE
    ) {
      subsystems.propulsion = 'disabled';
      pushEffect(effects, { kind: 'propulsion_disabled' });
    }
  }

  return { subsystems, effects };
}

/** Force every subsystem offline (sunk / imploded). */
export function disabledAllSubsystems(): UnitSubsystems {
  return {
    propulsion: 'disabled',
    radar: 'disabled',
    hydrophone: 'disabled',
    activeSonar: 'disabled',
    lookout: 'disabled',
    steering: 'disabled',
    divePlanes: 'disabled',
  };
}

/**
 * Reverse a casualty for Controls audio-staged presentation (held blast cues).
 * Best-effort: stuck locks clear; does not restore a prior damaged→disabled chain.
 */
export function reverseCasualtyEffect(
  subsystems: UnitSubsystems,
  effect: CasualtyEffect,
): UnitSubsystems {
  const next = resolveSubsystems({ ...subsystems });
  switch (effect.kind) {
    case 'propulsion_damaged':
      if (next.propulsion === 'damaged') next.propulsion = 'intact';
      break;
    case 'propulsion_disabled':
      if (next.propulsion === 'disabled') next.propulsion = 'intact';
      break;
    case 'radar_disabled':
      next.radar = 'intact';
      break;
    case 'hydrophone_disabled':
      next.hydrophone = 'intact';
      break;
    case 'active_sonar_disabled':
      next.activeSonar = 'intact';
      break;
    case 'lookout_disabled':
      next.lookout = 'intact';
      break;
    case 'steering_disabled':
      next.steering = 'intact';
      delete next.rudderStuckHeading;
      break;
    case 'rudder_stuck':
      next.steering = 'intact';
      delete next.rudderStuckHeading;
      break;
    case 'dive_planes_stuck':
    case 'dive_planes_disabled':
      next.divePlanes = 'intact';
      delete next.divePlanesStuckDepth;
      break;
  }
  return next;
}

export function presentationSubsystemsFromUnrevealed(
  resolved: UnitSubsystems,
  unrevealed: ReadonlyArray<{ kind: string; casualtyEffect?: CasualtyEffect }>,
): UnitSubsystems {
  let next = resolveSubsystems(resolved);
  for (const e of unrevealed) {
    if (e.kind === 'subsystem_casualty' && e.casualtyEffect) {
      next = reverseCasualtyEffect(next, e.casualtyEffect);
    }
  }
  return next;
}

export function applyHealthDamageResult(
  unit: UnitState,
  damage: number,
  rng: () => number = Math.random,
): { unit: UnitState; effects: CasualtyEffect[] } {
  if (damage <= 0 || unit.condition === 'sunk') {
    return { unit, effects: [] };
  }
  const health = Math.max(0, unit.health - damage);
  if (health <= 0) {
    return {
      unit: {
        ...unit,
        health: 0,
        condition: 'sunk',
        speed: 0,
        eot: 'stop',
        activeSonarEnabled: false,
        periscopeRaised: false,
        periscopeExposure: 0,
        plotStampTurns: 0,
        subsystems: disabledAllSubsystems(),
      },
      effects: [],
    };
  }

  const { subsystems, effects } = rollCombatCasualties({ ...unit, health }, health, rng);

  const propulsionOut = subsystems.propulsion === 'disabled';
  const lookoutOut = subsystems.lookout === 'disabled' && unit.type === 'Submarine';
  const sonarOut = subsystems.activeSonar === 'disabled';

  let speed = unit.speed;
  let eot = unit.eot;
  if (propulsionOut) {
    speed = 0;
    eot = 'stop';
  } else if (subsystems.propulsion === 'damaged') {
    // Soft-clamp current speed toward the damaged ceiling on the hit itself.
    const factor = PROPULSION_DAMAGED_SPEED_FACTOR;
    const cap = Math.abs(unit.maxSpeed) * factor;
    if (Math.abs(speed) > cap) {
      speed = speed >= 0 ? cap : -cap;
    }
  }

  let orderedCourse = unit.orderedCourse;
  if (subsystems.steering === 'stuck' && subsystems.rudderStuckHeading != null) {
    orderedCourse = subsystems.rudderStuckHeading;
  }

  let orderedDepth = unit.orderedDepth;
  if (
    (subsystems.divePlanes === 'stuck' || subsystems.divePlanes === 'disabled') &&
    subsystems.divePlanesStuckDepth != null
  ) {
    orderedDepth = subsystems.divePlanesStuckDepth;
  }

  return {
    unit: {
      ...unit,
      health,
      subsystems,
      speed,
      eot,
      orderedCourse,
      orderedDepth,
      activeSonarEnabled: sonarOut ? false : unit.activeSonarEnabled,
      periscopeRaised: lookoutOut ? false : unit.periscopeRaised,
      periscopeExposure: lookoutOut ? 0 : unit.periscopeExposure,
      plotStampTurns: lookoutOut ? 0 : unit.plotStampTurns,
    },
    effects,
  };
}

/** Apply HP damage + casualty rolls; returns the updated unit only. */
export function applyHealthDamage(
  unit: UnitState,
  damage: number,
  rng: () => number = Math.random,
): UnitState {
  return applyHealthDamageResult(unit, damage, rng).unit;
}

/** Operator / CRT label for a propulsion or binary / steering / dive state. */
export function subsystemStateLabel(state: string): string {
  switch (state) {
    case 'disabled':
      return 'DISABLED';
    case 'damaged':
      return 'DAMAGED';
    case 'stuck':
      return 'STUCK';
    default:
      return 'INTACT';
  }
}
