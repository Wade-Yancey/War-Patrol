import { normalizeHeading } from './geo.js';
import type {
  EotSetting,
  FormationState,
  Scenario,
  ScenarioFormationSeed,
  UnitState,
} from './types.js';

/** True when the unit is a member of a formation (convoy / column). */
export function hasFormation(unit: Pick<UnitState, 'formationId'>): boolean {
  return Boolean(unit.formationId?.trim());
}

/**
 * True when the unit follows group helm/EOT orders.
 * Detached members keep {@link UnitState.formationId} for roster display
 * but ignore subsequent group applies until they rejoin.
 */
export function followsFormation(
  unit: Pick<UnitState, 'formationId' | 'formationDetached'>,
): boolean {
  return hasFormation(unit) && !unit.formationDetached;
}

/** Members of a formation id (includes detached — for umpire roster). */
export function formationMembers(
  units: UnitState[],
  formationId: string,
): UnitState[] {
  const id = formationId.trim();
  if (!id) return [];
  return units.filter((u) => u.formationId === id);
}

/** Non-detached members that receive the next group order apply. */
export function formationFollowers(
  units: UnitState[],
  formationId: string,
): UnitState[] {
  const id = formationId.trim();
  if (!id) return [];
  return units.filter((u) => u.formationId === id && !u.formationDetached);
}

function humanizeFormationId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build {@link FormationState} list from live units + optional scenario name seeds.
 * Standing course/EOT seed from the first follower (else first member).
 */
export function buildFormationsFromUnits(
  units: UnitState[],
  nameSeeds?: ScenarioFormationSeed[] | undefined,
): FormationState[] {
  const nameById = new Map<string, string>();
  for (const seed of nameSeeds ?? []) {
    const id = seed.id?.trim();
    if (!id) continue;
    nameById.set(id, seed.name?.trim() || humanizeFormationId(id));
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    const id = u.formationId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  ids.sort((a, b) => a.localeCompare(b));

  return ids.map((id) => {
    const members = formationMembers(units, id);
    const lead = formationFollowers(units, id)[0] ?? members[0];
    return {
      id,
      name: nameById.get(id) ?? humanizeFormationId(id),
      orderedCourse: normalizeHeading(lead?.orderedCourse ?? lead?.heading ?? 0),
      eot: (lead?.eot ?? 'ahead_standard') as EotSetting,
    };
  });
}

/**
 * Ensure every formationId present on units has a FormationState entry.
 * Preserves existing standing course/EOT when the id already exists.
 */
export function reconcileFormations(
  existing: FormationState[] | undefined,
  units: UnitState[],
  nameSeeds?: ScenarioFormationSeed[] | undefined,
): FormationState[] {
  const built = buildFormationsFromUnits(units, nameSeeds);
  const prev = new Map((existing ?? []).map((f) => [f.id, f]));
  return built.map((f) => {
    const old = prev.get(f.id);
    if (!old) return f;
    return {
      ...f,
      name: old.name || f.name,
      orderedCourse: normalizeHeading(old.orderedCourse),
      eot: old.eot,
    };
  });
}

/** Optional scenario-level formation name seeds (id → display name). */
export function scenarioFormationSeeds(scenario: Scenario): ScenarioFormationSeed[] {
  return scenario.formations ?? [];
}
