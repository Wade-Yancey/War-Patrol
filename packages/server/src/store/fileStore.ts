import { mkdir, readdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  type GameSave,
  type Scenario,
  type VesselClassStub,
} from '@war-patrol/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** packages/server/data — stable whether running from src or dist. */
export function dataRoot(): string {
  // src/store -> ../../data ; dist/store -> ../../data
  return path.resolve(__dirname, '../../data');
}

export function scenariosDir(): string {
  return path.join(dataRoot(), 'scenarios');
}

export function savesDir(): string {
  return path.join(dataRoot(), 'saves');
}

export function libraryDir(): string {
  return path.join(dataRoot(), 'library');
}

async function ensureDirs(): Promise<void> {
  await mkdir(scenariosDir(), { recursive: true });
  await mkdir(savesDir(), { recursive: true });
  await mkdir(libraryDir(), { recursive: true });
}

/**
 * Reject path traversal / separator tricks in save & scenario ids.
 * Ids are single path segments under data/saves or data/scenarios (e.g. nanoid).
 */
export function assertSafeDataId(id: string, kind = 'id'): string {
  if (typeof id !== 'string' || !id) {
    throw Object.assign(new Error(`Invalid ${kind}`), { statusCode: 400 });
  }
  // No absolute paths, drive letters, separators, or `..` segments.
  if (
    id.includes('\0') ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('..') ||
    path.isAbsolute(id)
  ) {
    throw Object.assign(new Error(`Invalid ${kind}`), { statusCode: 400 });
  }
  // Defense in depth: resolved path must stay inside the intended root.
  // Callers join `${id}.json` under saves/scenarios — validate the bare id form.
  if (id !== path.basename(id)) {
    throw Object.assign(new Error(`Invalid ${kind}`), { statusCode: 400 });
  }
  return id;
}

function savePathForId(id: string): string {
  const safe = assertSafeDataId(id, 'save id');
  const filePath = path.resolve(savesDir(), `${safe}.json`);
  const root = path.resolve(savesDir()) + path.sep;
  if (!filePath.startsWith(root)) {
    throw Object.assign(new Error('Invalid save id'), { statusCode: 400 });
  }
  return filePath;
}

function scenarioPathForId(id: string): string {
  const safe = assertSafeDataId(id, 'scenario id');
  const filePath = path.resolve(scenariosDir(), `${safe}.json`);
  const root = path.resolve(scenariosDir()) + path.sep;
  if (!filePath.startsWith(root)) {
    throw Object.assign(new Error('Invalid scenario id'), { statusCode: 400 });
  }
  return filePath;
}

function assertSchemaVersion(doc: { schemaVersion?: number }, kind: string): void {
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `${kind} schemaVersion ${String(doc.schemaVersion)} unsupported (need ${SCHEMA_VERSION})`,
    );
  }
}

export async function listScenarios(): Promise<Scenario[]> {
  await ensureDirs();
  const files = (await readdir(scenariosDir())).filter((f) => f.endsWith('.json'));
  const out: Scenario[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(scenariosDir(), file), 'utf8');
    const scenario = JSON.parse(raw) as Scenario;
    assertSchemaVersion(scenario, 'Scenario');
    out.push(scenario);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadScenario(id: string): Promise<Scenario> {
  assertSafeDataId(id, 'scenario id');
  const scenarios = await listScenarios();
  const found = scenarios.find((s) => s.id === id);
  if (!found) {
    // Also try filename (must still be a single safe segment).
    const filePath = scenarioPathForId(id);
    try {
      await access(filePath);
      const raw = await readFile(filePath, 'utf8');
      const scenario = JSON.parse(raw) as Scenario;
      assertSchemaVersion(scenario, 'Scenario');
      return scenario;
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw new Error(`Scenario not found: ${id}`);
    }
  }
  return found;
}

export async function listSaves(): Promise<Array<{ id: string; name: string; updatedAt: string }>> {
  await ensureDirs();
  const files = (await readdir(savesDir())).filter((f) => f.endsWith('.json'));
  const out: Array<{ id: string; name: string; updatedAt: string }> = [];
  for (const file of files) {
    const raw = await readFile(path.join(savesDir(), file), 'utf8');
    const save = JSON.parse(raw) as GameSave;
    assertSchemaVersion(save, 'Save');
    out.push({ id: save.id, name: save.name, updatedAt: save.updatedAt });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadSave(id: string): Promise<GameSave> {
  await ensureDirs();
  const filePath = savePathForId(id);
  const raw = await readFile(filePath, 'utf8');
  const save = JSON.parse(raw) as GameSave;
  assertSchemaVersion(save, 'Save');
  return save;
}

export async function writeSave(save: GameSave): Promise<void> {
  await ensureDirs();
  assertSchemaVersion(save, 'Save');
  const filePath = savePathForId(save.id);
  await writeFile(filePath, JSON.stringify(save, null, 2), 'utf8');
}

/** Remove a save JSON file from disk. Returns false if missing. */
export async function deleteSaveFile(id: string): Promise<boolean> {
  await ensureDirs();
  const filePath = savePathForId(id);
  try {
    await access(filePath);
  } catch {
    return false;
  }
  await unlink(filePath);
  return true;
}

/** Remove every save JSON file from disk. Returns how many files were deleted. */
export async function deleteAllSaveFiles(): Promise<number> {
  await ensureDirs();
  const files = (await readdir(savesDir())).filter((f) => f.endsWith('.json'));
  let deleted = 0;
  for (const file of files) {
    await unlink(path.join(savesDir(), file));
    deleted += 1;
  }
  return deleted;
}

/** Remove a scenario JSON file from disk. Returns false if missing. */
export async function deleteScenarioFile(id: string): Promise<boolean> {
  await ensureDirs();
  // Reject traversal before any disk work (also covers the by-id fallback path).
  assertSafeDataId(id, 'scenario id');
  const filePath = scenarioPathForId(id);
  try {
    await access(filePath);
  } catch {
    // Also try matching by scenario.id inside files (filename may differ).
    const scenarios = await listScenarios();
    const found = scenarios.find((s) => s.id === id);
    if (!found) return false;
    const byId = scenarioPathForId(found.id);
    try {
      await access(byId);
      await unlink(byId);
      return true;
    } catch {
      return false;
    }
  }
  await unlink(filePath);
  return true;
}

export async function writeScenario(scenario: Scenario): Promise<void> {
  await ensureDirs();
  assertSchemaVersion(scenario, 'Scenario');
  const filePath = scenarioPathForId(scenario.id);
  await writeFile(filePath, JSON.stringify(scenario, null, 2), 'utf8');
}

export async function listVesselClasses(): Promise<VesselClassStub[]> {
  await ensureDirs();
  const files = (await readdir(libraryDir())).filter((f) => f.endsWith('.json'));
  const out: VesselClassStub[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(libraryDir(), file), 'utf8');
    out.push(JSON.parse(raw) as VesselClassStub);
  }
  return out;
}

export async function exportScenarioJson(scenario: Scenario): Promise<string> {
  assertSchemaVersion(scenario, 'Scenario');
  return JSON.stringify(scenario, null, 2);
}
