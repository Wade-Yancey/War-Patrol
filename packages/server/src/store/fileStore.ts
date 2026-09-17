import { mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
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
  const scenarios = await listScenarios();
  const found = scenarios.find((s) => s.id === id);
  if (!found) {
    // Also try filename
    const filePath = path.join(scenariosDir(), `${id}.json`);
    try {
      await access(filePath);
      const raw = await readFile(filePath, 'utf8');
      const scenario = JSON.parse(raw) as Scenario;
      assertSchemaVersion(scenario, 'Scenario');
      return scenario;
    } catch {
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
  const filePath = path.join(savesDir(), `${id}.json`);
  const raw = await readFile(filePath, 'utf8');
  const save = JSON.parse(raw) as GameSave;
  assertSchemaVersion(save, 'Save');
  return save;
}

export async function writeSave(save: GameSave): Promise<void> {
  await ensureDirs();
  assertSchemaVersion(save, 'Save');
  const filePath = path.join(savesDir(), `${save.id}.json`);
  await writeFile(filePath, JSON.stringify(save, null, 2), 'utf8');
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
