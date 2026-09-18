/**
 * Ground-truth stability check:
 * N resolves with known orders; assert positions / headings / speeds / clock,
 * no NaN or teleports, turn-rate caps, and radar surface rules.
 *
 * Run: `pnpm verify:stability` (also invoked from `pnpm verify`).
 */
import {
  KNOTS_TO_MPS,
  bearingRangeNm,
  clamp,
  clampSpeedToMax,
  effectiveMaxSpeed,
  eotTargetSpeed,
  moveAlongHeading,
  normalizeHeading,
  resolveSpeedStepFraction,
  type EotSetting,
  type HullClass,
  type LatLonDepth,
  type UnitState,
  type VesselType,
} from '@war-patrol/shared';
import { buildApp } from './app.js';
import { runtime } from './game/runtime.js';

type Json = Record<string, unknown>;

const TURNS = 8;
/** Max plausible displacement per turn (~flank destroyer over 5 min) + slack. */
const MAX_TELEPORT_NM = 8;
const POS_EPS = 1e-9;
const HEADING_EPS = 1e-9;
const SPEED_EPS = 1e-9;

type ExpectedUnit = {
  id: string;
  type: VesselType;
  class: HullClass;
  position: LatLonDepth;
  heading: number;
  orderedCourse: number;
  speed: number;
  eot: EotSetting;
  turnRate: number;
  maxSpeed: number;
};

/** Independent mirror of turnEngine.applyUnitOrders using shared helpers. */
function expectApply(
  unit: ExpectedUnit,
  orders: { course?: number; eot?: EotSetting },
  turnLengthSeconds: number,
): ExpectedUnit {
  let orderedCourse = unit.orderedCourse;
  let heading = unit.heading;
  let eot = unit.eot;
  let speed = unit.speed;

  if (orders.course !== undefined) {
    orderedCourse = normalizeHeading(orders.course);
  }

  const maxDelta = unit.turnRate * (turnLengthSeconds / 60);
  heading = turnToward(heading, orderedCourse, maxDelta);

  if (orders.eot !== undefined) eot = orders.eot;

  const speedCeiling = effectiveMaxSpeed({
    type: unit.type,
    maxSpeed: unit.maxSpeed,
    depth: unit.position.depth,
  });
  const target = eotTargetSpeed(eot, speedCeiling);
  const step =
    speedCeiling * resolveSpeedStepFraction({ class: unit.class, type: unit.type });
  if (speed < target) speed = Math.min(target, speed + step);
  else if (speed > target) speed = Math.max(target, speed - step);
  speed = clampSpeedToMax(speed, speedCeiling);

  const distance = Math.abs(speed) * KNOTS_TO_MPS * turnLengthSeconds;
  const moveHeading = speed >= 0 ? heading : normalizeHeading(heading + 180);
  const position =
    distance > 0 ? moveAlongHeading(unit.position, moveHeading, distance) : unit.position;

  return {
    ...unit,
    heading: normalizeHeading(heading),
    orderedCourse: normalizeHeading(orderedCourse),
    eot,
    speed,
    position,
  };
}

function turnToward(current: number, desired: number, maxDelta: number): number {
  const cur = normalizeHeading(current);
  const des = normalizeHeading(desired);
  let delta = des - cur;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return normalizeHeading(cur + clamp(delta, -maxDelta, maxDelta));
}

function headingDelta(a: number, b: number): number {
  let d = normalizeHeading(b) - normalizeHeading(a);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function rangeNm(a: LatLonDepth, b: LatLonDepth): number {
  return bearingRangeNm(a, b).rangeNm;
}

function finite(n: number): boolean {
  return Number.isFinite(n) && !Number.isNaN(n);
}

export async function runStabilityCheck(baseUrl?: string): Promise<string[]> {
  const results: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) throw new Error(`FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  let base = baseUrl;
  let ownServer = false;

  if (!base) {
    app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    base = `http://127.0.0.1:${address.port}`;
    ownServer = true;
  }

  const api = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    return { status: res.status, json };
  };

  try {
    const created = await api('POST', '/api/games', {
      scenarioId: 'destroyer-sub-demo',
      name: 'Stability Check',
    });
    check('stability create', created.status === 200);
    const gameId = created.json.gameId as string;

    const umpireAuth = await api('POST', `/api/games/${gameId}/auth/umpire`, {
      password: 'umpire',
    });
    const umpireToken = umpireAuth.json.token as string;
    const blueAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'bridge',
    });
    const blueToken = blueAuth.json.token as string;
    const redAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'conn',
    });
    const redToken = redAuth.json.token as string;
    const radarAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'radar',
    });
    const radarToken = radarAuth.json.token as string;

    const save0 = runtime.requireGame(gameId);
    const turnLength = save0.turnLengthSeconds;
    let clock = save0.turn.gameTimeSeconds;
    check('start clock 08:00', clock === 28800);

    const seedExpected = (u: UnitState): ExpectedUnit => ({
      id: u.id,
      type: u.type,
      class: u.class,
      position: { ...u.position },
      heading: u.heading,
      orderedCourse: u.orderedCourse,
      speed: u.speed,
      eot: u.eot,
      turnRate: u.turnRate,
      maxSpeed: u.maxSpeed,
    });

    let expected = {
      'dd-101': seedExpected(save0.units.find((u) => u.id === 'dd-101')!),
      'ss-212': seedExpected(save0.units.find((u) => u.id === 'ss-212')!),
    };

    // Fixed order schedule (standing course after first set; eot changes mid-run).
    const schedule: Array<{
      blue: { course?: number; eot?: EotSetting };
      red: { course?: number; eot?: EotSetting };
    }> = [
      { blue: { course: 45, eot: 'ahead_full' }, red: { course: 180, eot: 'ahead_1' } },
      { blue: { course: 45 }, red: { course: 180 } },
      { blue: { course: 10, eot: 'ahead_standard' }, red: { course: 270, eot: 'ahead_2' } },
      { blue: { course: 10 }, red: { course: 270 } },
      { blue: { course: 350, eot: 'ahead_flank' }, red: { course: 90, eot: 'stop' } },
      { blue: { course: 350 }, red: { course: 90, eot: 'ahead_1' } },
      { blue: { course: 200, eot: 'ahead_2' }, red: { course: 200, eot: 'ahead_standard' } },
      { blue: { course: 200 }, red: { course: 200 } },
    ];

    check('schedule length', schedule.length === TURNS);

    for (let i = 0; i < TURNS; i++) {
      const orders = schedule[i]!;
      const before = runtime.requireGame(gameId);
      const blueBefore = before.units.find((u) => u.id === 'dd-101')!;
      const redBefore = before.units.find((u) => u.id === 'ss-212')!;

      await api('POST', `/api/games/${gameId}/orders`, orders.blue, blueToken);
      await api('POST', `/api/games/${gameId}/orders`, orders.red, redToken);
      const resolved = await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
      check(`turn ${i + 1} resolve`, resolved.status === 200);

      expected['dd-101'] = expectApply(expected['dd-101'], orders.blue, turnLength);
      expected['ss-212'] = expectApply(expected['ss-212'], orders.red, turnLength);
      clock += turnLength;

      const after = runtime.requireGame(gameId);
      check(`turn ${i + 1} number`, after.turn.number === i + 2);
      check(`turn ${i + 1} clock`, after.turn.gameTimeSeconds === clock, `got ${after.turn.gameTimeSeconds}`);

      for (const id of ['dd-101', 'ss-212'] as const) {
        const unit = after.units.find((u) => u.id === id)!;
        const exp = expected[id];
        const prev = id === 'dd-101' ? blueBefore : redBefore;

        check(
          `${id} T${i + 1} finite`,
          finite(unit.position.lat) &&
            finite(unit.position.lon) &&
            finite(unit.heading) &&
            finite(unit.speed) &&
            finite(unit.orderedCourse),
        );

        const hop = rangeNm(prev.position, unit.position);
        check(`${id} T${i + 1} no teleport`, hop < MAX_TELEPORT_NM, `Δ=${hop.toFixed(3)} nm`);

        const yaw = Math.abs(headingDelta(prev.heading, unit.heading));
        const maxYaw = unit.turnRate * (turnLength / 60) + HEADING_EPS;
        check(`${id} T${i + 1} turn rate cap`, yaw <= maxYaw, `yaw=${yaw.toFixed(4)} max=${maxYaw}`);

        check(
          `${id} T${i + 1} heading`,
          Math.abs(headingDelta(unit.heading, exp.heading)) < HEADING_EPS,
          `got ${unit.heading} want ${exp.heading}`,
        );
        check(
          `${id} T${i + 1} orderedCourse`,
          Math.abs(headingDelta(unit.orderedCourse, exp.orderedCourse)) < HEADING_EPS,
        );
        check(
          `${id} T${i + 1} speed`,
          Math.abs(unit.speed - exp.speed) < SPEED_EPS,
          `got ${unit.speed} want ${exp.speed}`,
        );
        check(
          `${id} T${i + 1} lat`,
          Math.abs(unit.position.lat - exp.position.lat) < POS_EPS,
          `got ${unit.position.lat} want ${exp.position.lat}`,
        );
        check(
          `${id} T${i + 1} lon`,
          Math.abs(unit.position.lon - exp.position.lon) < POS_EPS,
          `got ${unit.position.lon} want ${exp.position.lon}`,
        );
        check(`${id} T${i + 1} depth unchanged`, unit.position.depth === prev.position.depth);
      }

      // Radar: both surfaced → Porter sees Gato
      const radarSurf = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
      const contacts = (radarSurf.json.view as Json).radarContacts as unknown[];
      check(`radar T${i + 1} surfaced contact`, contacts.length >= 1);
    }

    // Dive Gato → echo clears; own sub radar unavailable
    await api(
      'PATCH',
      `/api/games/${gameId}/units/ss-212`,
      { position: { depth: 40 } },
      umpireToken,
    );
    const radarDive = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
    check(
      'radar clears submerged target',
      ((radarDive.json.view as Json).radarContacts as unknown[]).length === 0,
    );

    const subRadarAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'radar',
    });
    const subRadar = await api(
      'GET',
      `/api/games/${gameId}/view`,
      undefined,
      subRadarAuth.json.token as string,
    );
    const srv = subRadar.json.view as Json;
    check('sub radar unavailable submerged', srv.radarOperational === false);
    check('sub radar reason submerged', srv.radarUnavailableReason === 'submerged');

    // Cleanup: delete the save so verify does not leave orphans on disk
    const del = await api('DELETE', `/api/saves/${gameId}`);
    check('stability cleanup delete save', del.status === 200);
    check('stability unloaded', del.json.unloaded === true || del.json.deletedFile === true);
    check('stability not in memory', runtime.getGame(gameId) === undefined);

    return results;
  } finally {
    if (ownServer && app) await app.close();
  }
}

async function main() {
  const results = await runStabilityCheck();
  console.log('\n=== War Patrol ground-truth stability ===');
  for (const line of results) console.log(line);
  console.log(`ALL ${results.length} STABILITY CHECKS PASSED (${TURNS} turns)`);
  process.exit(0);
}

// Allow import from verify without running main
const isDirect =
  process.argv[1]?.endsWith('stabilityCheck.ts') ||
  process.argv[1]?.endsWith('stabilityCheck.js');

if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
