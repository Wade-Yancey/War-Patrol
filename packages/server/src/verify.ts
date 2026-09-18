/**
 * End-to-end verification script:
 * create → join two vessels → orders → lock → resolve → SSE stateVersion,
 * plus save/load and rollback.
 */
import { buildApp } from './app.js';
import { runtime } from './game/runtime.js';
import {
  CLASS_MAX_SPEED_KNOTS,
  CLASS_SPEED_STEP_FRACTION,
  SUBMERGED_MAX_SPEED_KNOTS,
  clampSpeedToMax,
  editMaxSpeedForClass,
  effectiveMaxSpeed,
  formatWallDuration,
  parseWallDuration,
  resolveMaxSpeed,
  snapWallDuration,
} from '@war-patrol/shared';

type Json = Record<string, unknown>;

async function main() {
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const base = `http://127.0.0.1:${address.port}`;

  const results: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) throw new Error(`FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  };

  check('formatWallDuration minutes-first', formatWallDuration(180) === '3m');
  check('formatWallDuration with seconds', formatWallDuration(210) === '3m 30s');
  check('parseWallDuration bare minutes', parseWallDuration('3') === 180);
  check('parseWallDuration mm:ss', parseWallDuration('3:30') === 210);
  check('snapWallDuration 30s', snapWallDuration(200, 30) === 210);

  check('class max Destroyer 36', CLASS_MAX_SPEED_KNOTS.Destroyer === 36);
  check('class max Fleet Submarine 20', CLASS_MAX_SPEED_KNOTS['Fleet Submarine'] === 20);
  check('class max Fighter 320', CLASS_MAX_SPEED_KNOTS.Fighter === 320);
  check('class max Merchant 11', CLASS_MAX_SPEED_KNOTS.Merchant === 11);
  check(
    'resolveMaxSpeed prefers explicit',
    resolveMaxSpeed({ maxSpeed: 21, class: 'Fleet Submarine' }) === 21,
  );
  check(
    'resolveMaxSpeed class default',
    resolveMaxSpeed({ class: 'Battleship' }) === 33,
  );
  check('destroyer accelerates faster than merchant', CLASS_SPEED_STEP_FRACTION.Destroyer > CLASS_SPEED_STEP_FRACTION.Merchant);
  check(
    'editMaxSpeed prefers unit when class matches',
    editMaxSpeedForClass({
      draftClass: 'Fleet Submarine',
      unitClass: 'Fleet Submarine',
      unitMaxSpeed: 21,
    }) === 21,
  );
  check(
    'editMaxSpeed uses class table when draft differs',
    editMaxSpeedForClass({
      draftClass: 'Merchant',
      unitClass: 'Destroyer',
      unitMaxSpeed: 36,
    }) === 11,
  );
  check('clampSpeedToMax caps high', clampSpeedToMax(99, 36) === 36);
  check('clampSpeedToMax caps reverse', clampSpeedToMax(-50, 36) === -36);
  check('submerged max is 9 kn', SUBMERGED_MAX_SPEED_KNOTS === 9);
  check(
    'effectiveMaxSpeed surfaced hull',
    effectiveMaxSpeed({ type: 'Submarine', maxSpeed: 21, depth: 0 }) === 21,
  );
  check(
    'effectiveMaxSpeed submerged caps 9',
    effectiveMaxSpeed({ type: 'Submarine', maxSpeed: 21, depth: 40 }) === 9,
  );
  check(
    'ships ignore depth for speed',
    effectiveMaxSpeed({ type: 'Ship', maxSpeed: 36, depth: 40 }) === 36,
  );

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

  // 1. Create game
  const created = await api('POST', '/api/games', {
    scenarioId: 'destroyer-sub-demo',
    name: 'Verify Engagement',
  });
  check('create game', created.status === 200 && typeof created.json.gameId === 'string');
  const gameId = created.json.gameId as string;

  // 2. Auth umpire + vessels
  const umpireAuth = await api('POST', `/api/games/${gameId}/auth/umpire`, { password: 'umpire' });
  check('umpire auth', umpireAuth.status === 200 && typeof umpireAuth.json.token === 'string');
  const umpireToken = umpireAuth.json.token as string;

  const blueAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'blue',
    stationId: 'controls',
  });
  check('blue vessel auth', blueAuth.status === 200);
  const blueToken = blueAuth.json.token as string;

  const redAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'gato-demo',
    password: 'red',
    stationId: 'controls',
  });
  check('red vessel auth', redAuth.status === 200);
  const redToken = redAuth.json.token as string;

  // 3. Filtered view: blue must not see red ground truth
  const blueView = await api('GET', `/api/games/${gameId}/view`, undefined, blueToken);
  check('blue filtered view', blueView.status === 200);
  const bv = blueView.json.view as Json;
  check('blue role vessel', bv.role === 'vessel');
  check('blue unit is Porter', (bv.unit as Json).name === 'USS Porter');
  check('blue own-ship type', (bv.unit as Json).type === 'Ship');
  check('blue own-ship class', (bv.unit as Json).class === 'Destroyer');
  check('blue own-ship faction', (bv.unit as Json).faction === 'Blue');
  check('blue has no units array', !('units' in bv));

  const umpireView = await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken);
  check('umpire ground truth', umpireView.status === 200);
  const uv = umpireView.json.view as Json;
  check('umpire sees both units', Array.isArray(uv.units) && (uv.units as unknown[]).length === 2);
  const links = uv.vesselLinks as Array<{
    unitId: string;
    playerVessel?: boolean;
    stations: unknown[];
  }>;
  check(
    'demo player vessel links',
    links.every((l) => l.playerVessel === true && Array.isArray(l.stations) && l.stations.length > 0),
  );

  // 3b. Radar station: filtered polar contacts, no other-unit ground truth
  const radarAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'blue',
    stationId: 'sensors',
  });
  check('radar station auth', radarAuth.status === 200);
  const radarToken = radarAuth.json.token as string;
  const radarViewRes = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  check('radar view ok', radarViewRes.status === 200);
  const rv = radarViewRes.json.view as Json;
  check('radar has contacts array', Array.isArray(rv.radarContacts));
  const contacts = rv.radarContacts as Array<Json>;
  check('radar sees surfaced contact', contacts.length >= 1, `got ${contacts.length}`);
  check('radar contact polar only', !('position' in contacts[0]) && typeof contacts[0].bearing === 'number');
  check('radar contact no identity fields', !('side' in contacts[0]) && !('name' in contacts[0]) && !('classId' in contacts[0]) && !('class' in contacts[0]) && !('type' in contacts[0]) && !('faction' in contacts[0]));
  check(
    'radar contact has signature size',
    contacts[0].signature === 'small' ||
      contacts[0].signature === 'medium' ||
      contacts[0].signature === 'large',
    `got ${String(contacts[0].signature)}`,
  );
  check('radar contact signature is small (surfaced sub)', contacts[0].signature === 'small');
  check('radar has max range', typeof rv.radarMaxRangeNm === 'number' && (rv.radarMaxRangeNm as number) > 0);
  const porter = (uv.units as Json[]).find((u) => u.id === 'dd-101')!;
  const gato = (uv.units as Json[]).find((u) => u.id === 'ss-212')!;
  check('destroyer radarSignature medium', porter.radarSignature === 'medium');
  check('sub radarSignature small', gato.radarSignature === 'small');
  check('porter type Ship', porter.type === 'Ship');
  check('porter class Destroyer', porter.class === 'Destroyer');
  check('porter maxSpeed Fletcher 36 kn', porter.maxSpeed === 36);
  check('porter faction Blue', porter.faction === 'Blue');
  check('porter afloat', porter.condition === 'afloat');
  check('porter propulsion intact', (porter.subsystems as Json).propulsion === 'intact');
  check('porter sensors intact', (porter.subsystems as Json).sensors === 'intact');
  check('porter depth surface', (porter.position as Json).depth === 0);
  check('gato type Submarine', gato.type === 'Submarine');
  check('gato class Fleet Submarine', gato.class === 'Fleet Submarine');
  check('gato maxSpeed Gato 21 kn', gato.maxSpeed === 21);
  check('demo speeds distinct', (porter.maxSpeed as number) > (gato.maxSpeed as number));
  check('gato faction Red', gato.faction === 'Red');
  check('gato afloat', gato.condition === 'afloat');
  check('destroyer turnRate medium size', porter.turnRate === 7);
  check('sub turnRate small size', gato.turnRate === 12);
  check('orderedCourse seeded to heading (porter)', porter.orderedCourse === porter.heading);
  check(
    'orderedDepth seeded to position (gato)',
    gato.orderedDepth === (gato.position as Json).depth,
  );
  check('orderedDepth ship is 0', porter.orderedDepth === 0);
  check('game clock starts 08:00', (uv.turn as Json).gameTimeSeconds === 28800);
  check('turn length 5 min', uv.turnLengthSeconds === 300);
  check('order timer default 5 min', (uv.turn as Json).timerSeconds === 300);
  check('trails present', Array.isArray(uv.trails) && (uv.trails as unknown[]).length === 2);
  check(
    'destroyer two-screen stations only',
    Array.isArray(porter.stations) &&
      (porter.stations as Json[]).length === 2 &&
      (porter.stations as Json[]).every((s) => s.id === 'controls' || s.id === 'sensors') &&
      (porter.stations as Json[]).some(
        (s) =>
          s.id === 'sensors' &&
          Array.isArray(s.capabilities) &&
          (s.capabilities as string[]).includes('radar') &&
          (s.capabilities as string[]).includes('active_sonar'),
      ),
  );
  check(
    'destroyer has radar sensor',
    Array.isArray(porter.sensors) &&
      (porter.sensors as Json[]).some((s) => s.kind === 'radar'),
  );
  check(
    'destroyer has active_sonar sensor',
    Array.isArray(porter.sensors) &&
      (porter.sensors as Json[]).some((s) => s.kind === 'active_sonar'),
  );
  check(
    'destroyer has no hydrophone sensor',
    Array.isArray(porter.sensors) &&
      !(porter.sensors as Json[]).some((s) => s.kind === 'hydrophone'),
  );
  check(
    'sub two-screen stations only',
    Array.isArray(gato.stations) &&
      (gato.stations as Json[]).length === 2 &&
      (gato.stations as Json[]).every((s) => s.id === 'controls' || s.id === 'sensors') &&
      (gato.stations as Json[]).some(
        (s) =>
          s.id === 'sensors' &&
          Array.isArray(s.capabilities) &&
          (s.capabilities as string[]).includes('radar') &&
          (s.capabilities as string[]).includes('hydrophone') &&
          (s.capabilities as string[]).includes('lookout'),
      ),
  );
  check(
    'sub has radar sensor',
    Array.isArray(gato.sensors) && (gato.sensors as Json[]).some((s) => s.kind === 'radar'),
  );
  check(
    'sub has hydrophone sensor',
    Array.isArray(gato.sensors) &&
      (gato.sensors as Json[]).some((s) => s.kind === 'hydrophone'),
  );
  check(
    'sub has lookout/periscope sensor',
    Array.isArray(gato.sensors) &&
      (gato.sensors as Json[]).some((s) => s.kind === 'lookout'),
  );
  check('porter radar operational', rv.radarOperational === true);
  check('controls has no radar picture', !('radarContacts' in bv) || bv.radarContacts === undefined);
  check(
    'umpire vessel links are two screens',
    links.every(
      (l) =>
        Array.isArray(l.stations) &&
        (l.stations as Json[]).length === 2 &&
        (l.stations as Json[]).every((s) => s.stationId === 'controls' || s.stationId === 'sensors'),
    ),
  );
  const legacyBridge = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'blue',
    stationId: 'bridge',
  });
  check('legacy bridge station rejected', legacyBridge.status === 404);

  // 3c. Destroyer Sensors: active sonar toggle + forward cone (no hydrophone)
  check('destroyer sensors has sonar fields', typeof rv.sonarOperational === 'boolean');
  check('sonar off by default', rv.sonarOperational === false);
  check('sonar off reason', rv.sonarUnavailableReason === 'sonar_off');
  check('sonar half-angle stub', rv.sonarHalfAngleDeg === 30);
  check(
    'sonar max range stub',
    typeof rv.sonarMaxRangeNm === 'number' && (rv.sonarMaxRangeNm as number) === 8,
  );
  check('destroyer sensors has no hydrophone picture', !('hydrophoneContacts' in rv));

  const sonarOn = await api(
    'POST',
    `/api/games/${gameId}/active-sonar`,
    { enabled: true },
    radarToken,
  );
  check('active sonar toggle on', sonarOn.status === 200);
  const sonarViewOn = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const svo = sonarViewOn.json.view as Json;
  check('sonar operational when on', svo.sonarOperational === true);
  check('sonar contacts array when on', Array.isArray(svo.sonarContacts));
  // Gato is roughly NE of Porter heading 090 — may or may not be in ±30° cone depending on geometry.
  // Place Gato dead ahead for a deterministic cone hit, then restore.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    // Dead ahead of Porter (hdg 090) and inside active-sonar stub range (8 nm × small 0.7).
    { position: { lat: 34.35, lon: -120.05, depth: 40 } },
    umpireToken,
  );
  const sonarCone = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const scv = sonarCone.json.view as Json;
  const sonarContacts = scv.sonarContacts as Array<Json>;
  check('sonar paints submerged contact in forward cone', sonarContacts.length >= 1, `got ${sonarContacts.length}`);
  check(
    'sonar contact polar only',
    !('position' in sonarContacts[0]) &&
      typeof sonarContacts[0].bearing === 'number' &&
      typeof sonarContacts[0].rangeNm === 'number',
  );
  check(
    'sonar contact no identity fields',
    !('side' in sonarContacts[0]) &&
      !('name' in sonarContacts[0]) &&
      !('faction' in sonarContacts[0]),
  );
  check(
    'sonar contact has signature',
    sonarContacts[0].signature === 'small' ||
      sonarContacts[0].signature === 'medium' ||
      sonarContacts[0].signature === 'large',
  );
  await api(
    'POST',
    `/api/games/${gameId}/active-sonar`,
    { enabled: false },
    radarToken,
  );
  const sonarOffAgain = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  check(
    'sonar no contacts when off',
    ((sonarOffAgain.json.view as Json).sonarOperational === false) &&
      Array.isArray((sonarOffAgain.json.view as Json).sonarContacts) &&
      (((sonarOffAgain.json.view as Json).sonarContacts as unknown[])?.length ?? 0) === 0,
  );

  // Restore Gato near original, then exercise sub hydrophone Sensors
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { lat: 34.42, lon: -119.95, depth: 0 }, speed: 6, eot: 'ahead_2' },
    umpireToken,
  );

  // 3d. Sub Sensors hydrophone: submerged only; hears propellers + active-sonar pings
  const subSensorsAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'gato-demo',
    password: 'red',
    stationId: 'sensors',
  });
  check('sub sensors station auth', subSensorsAuth.status === 200);
  const subSensorsToken = subSensorsAuth.json.token as string;
  const subSurfSensors = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const sss = subSurfSensors.json.view as Json;
  check('sub hydrophone unavailable on surface', sss.hydrophoneOperational === false);
  check('sub hydrophone reason surfaced', sss.hydrophoneUnavailableReason === 'surfaced');
  check('sub radar live on surface (sensors)', sss.radarOperational === true);
  check('sub periscope live on surface', sss.periscopeOperational === true);
  check('sub periscope has contacts array', Array.isArray(sss.periscopeContacts));
  check(
    'sub periscope max range stub',
    typeof sss.periscopeMaxRangeNm === 'number' && (sss.periscopeMaxRangeNm as number) === 6,
  );

  // Place Porter within visual range for deterministic periscope contact
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { position: { lat: 34.43, lon: -119.96 }, speed: 12, eot: 'ahead_standard' },
    umpireToken,
  );
  const periSurf = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const periSurfView = periSurf.json.view as Json;
  const periContacts = periSurfView.periscopeContacts as Array<Json>;
  check('sub periscope sees destroyer on surface', periContacts.length >= 1, `got ${periContacts.length}`);
  check(
    'periscope contact relative bearing + range + speed',
    typeof periContacts[0].relativeBearing === 'number' &&
      typeof periContacts[0].rangeNm === 'number' &&
      typeof periContacts[0].speedKn === 'number',
  );
  check(
    'periscope contact silhouette class only',
    periContacts[0].silhouetteClass === 'Destroyer' &&
      !('side' in periContacts[0]) &&
      !('name' in periContacts[0]) &&
      !('faction' in periContacts[0]) &&
      !('position' in periContacts[0]),
  );
  check(
    'controls has no periscope picture',
    !('periscopeContacts' in bv) || bv.periscopeContacts === undefined,
  );

  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 18 } },
    umpireToken,
  );
  const periAt18 = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  check(
    'sub periscope operational at 18 m',
    (periAt18.json.view as Json).periscopeOperational === true,
  );

  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 40 } },
    umpireToken,
  );
  const periDeep = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const periDeepView = periDeep.json.view as Json;
  check('sub periscope unavailable too deep', periDeepView.periscopeOperational === false);
  check('sub periscope reason too_deep', periDeepView.periscopeUnavailableReason === 'too_deep');

  // Restore Porter near original for hydrophone checks
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { position: { lat: 34.35, lon: -120.1 }, speed: 12, eot: 'ahead_standard' },
    umpireToken,
  );

  const subDiveSensors = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const sds = subDiveSensors.json.view as Json;
  check('sub hydrophone operational submerged', sds.hydrophoneOperational === true);
  check('sub hydrophone has contacts array', Array.isArray(sds.hydrophoneContacts));
  const hContacts = sds.hydrophoneContacts as Array<Json>;
  check('sub hydrophone hears underway destroyer', hContacts.length >= 1, `got ${hContacts.length}`);
  check(
    'hydrophone contact polar only',
    !('position' in hContacts[0]) &&
      typeof hContacts[0].bearing === 'number' &&
      typeof hContacts[0].rangeNm === 'number',
  );
  check(
    'hydrophone contact has kind',
    hContacts[0].kind === 'propeller' || hContacts[0].kind === 'active_sonar_ping',
  );
  check(
    'hydrophone contact no identity fields',
    !('side' in hContacts[0]) &&
      !('name' in hContacts[0]) &&
      !('classId' in hContacts[0]) &&
      !('class' in hContacts[0]) &&
      !('type' in hContacts[0]) &&
      !('faction' in hContacts[0]) &&
      !('signature' in hContacts[0]),
  );
  check(
    'hydrophone has max range',
    typeof sds.hydrophoneMaxRangeNm === 'number' && (sds.hydrophoneMaxRangeNm as number) > 0,
  );
  check('controls has no hydrophone picture', !('hydrophoneContacts' in bv) || bv.hydrophoneContacts === undefined);

  // Active sonar ON on Porter → sub hydrophone hears ping contact
  await api('POST', `/api/games/${gameId}/active-sonar`, { enabled: true }, radarToken);
  const subHearsPing = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const pingContacts = ((subHearsPing.json.view as Json).hydrophoneContacts as Array<Json>).filter(
    (c) => c.kind === 'active_sonar_ping',
  );
  check('sub hydrophone hears active sonar pings', pingContacts.length >= 1, `got ${pingContacts.length}`);
  await api('POST', `/api/games/${gameId}/active-sonar`, { enabled: false }, radarToken);

  // Stop Porter → propeller silent but (when sonar off) no ping either
  await api('PATCH', `/api/games/${gameId}/units/dd-101`, { speed: 0, eot: 'stop' }, umpireToken);
  const hydroStopped = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  check(
    'hydrophone silent when destroyer stopped and sonar off',
    Array.isArray((hydroStopped.json.view as Json).hydrophoneContacts) &&
      ((hydroStopped.json.view as Json).hydrophoneContacts as unknown[]).length === 0,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { speed: 12, eot: 'ahead_standard' },
    umpireToken,
  );

  // Sub radar while surfaced can see destroyer
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 0 } },
    umpireToken,
  );
  const subRadarSurf = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const srv = subRadarSurf.json.view as Json;
  check('sub radar operational on surface', srv.radarOperational === true);
  check(
    'sub radar sees destroyer',
    Array.isArray(srv.radarContacts) && (srv.radarContacts as unknown[]).length >= 1,
  );

  // Dive sub → clears as target on Porter + own PPI unavailable + hydrophone up
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 40 } },
    umpireToken,
  );
  const radarAfterDive = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const contactsDived = (radarAfterDive.json.view as Json).radarContacts as unknown[];
  check('radar clears when submerged', contactsDived.length === 0, `got ${contactsDived.length}`);
  const subRadarDive = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const srd = subRadarDive.json.view as Json;
  check('sub radar unavailable submerged', srd.radarOperational === false);
  check('sub radar reason submerged', srd.radarUnavailableReason === 'submerged');
  check(
    'sub radar no contacts while submerged',
    Array.isArray(srd.radarContacts) && (srd.radarContacts as unknown[]).length === 0,
  );
  check('sub hydrophone up while submerged', srd.hydrophoneOperational === true);
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 0 } },
    umpireToken,
  );

  // Re-auth must not revoke sibling station tabs (ARCH-AC-09).
  const blueAuthAgain = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'blue',
    stationId: 'controls',
  });
  check('re-auth controls creates new session', blueAuthAgain.status === 200);
  const blueToken2 = blueAuthAgain.json.token as string;
  check('re-auth issues distinct token', blueToken2 !== blueToken);
  const oldStillValid = await api('GET', `/api/games/${gameId}/view`, undefined, blueToken);
  check('prior controls session still valid after re-auth', oldStillValid.status === 200);

  // Concurrent SSE: umpire + Porter Bridge + Porter Radar + Gato Conn (multi-tab).
  const openSseClient = async (label: string, token: string, signal: AbortSignal) => {
    const res = await fetch(
      `${base}/api/games/${gameId}/events?token=${encodeURIComponent(token)}`,
      { signal },
    );
    check(`SSE ${label} open`, res.status === 200 && Boolean(res.body));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotState = false;
    const deadline = Date.now() + 3000;
    while (!gotState && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.split('\n').some((l) => l.startsWith('data: '))) {
          gotState = true;
          break;
        }
      }
    }
    check(`SSE ${label} received state`, gotState);
    return { reader, res };
  };

  const multiAbort = new AbortController();
  const multiClients = await Promise.all([
    openSseClient('umpire', umpireToken, multiAbort.signal),
    openSseClient('porter-controls', blueToken, multiAbort.signal),
    openSseClient('porter-sensors', radarToken, multiAbort.signal),
    openSseClient('gato-controls', redToken, multiAbort.signal),
    openSseClient('porter-controls-tab2', blueToken2, multiAbort.signal),
  ]);
  const umpireLive = await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken);
  const connections = (umpireLive.json.view as Json).connections as Array<Json>;
  check(
    'multi-tab connection counts',
    Array.isArray(connections) && connections.reduce((n, c) => n + Number(c.count ?? 0), 0) >= 5,
    `got ${JSON.stringify(connections)}`,
  );
  multiAbort.abort();
  await Promise.all(
    multiClients.map(async (c) => {
      try {
        await c.reader.cancel();
      } catch {
        /* ignore */
      }
    }),
  );

  // 4. SSE: query-token auth (EventSource-safe) + wait for resolve push
  const sseUnauth = await fetch(`${base}/api/games/${gameId}/events`);
  check('SSE rejects missing token', sseUnauth.status === 401);

  const sseBad = await fetch(
    `${base}/api/games/${gameId}/events?token=${encodeURIComponent('not-a-real-token')}`,
  );
  check('SSE rejects bad query token', sseBad.status === 401);

  let sseVersions: number[] = [];
  const sseAbort = new AbortController();
  const ssePromise = (async () => {
    // Prefer query token — matches browser EventSource / client reconnect path.
    const res = await fetch(
      `${base}/api/games/${gameId}/events?token=${encodeURIComponent(blueToken)}`,
      { signal: sseAbort.signal },
    );
    check('SSE accepts query token', res.status === 200 && Boolean(res.body));
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(6)) as { stateVersion?: number };
          if (payload.stateVersion) sseVersions.push(payload.stateVersion);
        } catch {
          /* ignore */
        }
      }
      if (sseVersions.length >= 3) break;
    }
  })();

  // Bearer still accepted on SSE for non-browser clients.
  const sseBearer = await fetch(`${base}/api/games/${gameId}/events`, {
    headers: { Authorization: `Bearer ${umpireToken}` },
  });
  check('SSE accepts Bearer', sseBearer.status === 200 && Boolean(sseBearer.body));
  sseBearer.body?.cancel().catch(() => undefined);

  await new Promise((r) => setTimeout(r, 200));

  // 5. Submit orders
  const blueOrders = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { course: 45, eot: 'ahead_full' },
    blueToken,
  );
  check('blue orders', blueOrders.status === 200);

  const redOrders = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { course: 180, eot: 'ahead_1', depth: 50 },
    redToken,
  );
  check('red orders', redOrders.status === 200);

  const umpirePending = await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken);
  const pendingUnits = ((umpirePending.json.view as Json).units as Array<{
    id: string;
    name: string;
    orderedDepth?: number;
    position?: { depth?: number };
    orders: { course?: number; eot?: string; depth?: number; updatedByStationId?: string };
  }>);
  const bluePending = pendingUnits.find((u) => u.id === 'dd-101');
  const redPending = pendingUnits.find((u) => u.id === 'ss-212');
  check(
    'umpire sees blue pending orders',
    bluePending?.orders.course === 45 && bluePending?.orders.eot === 'ahead_full',
  );
  check(
    'umpire sees red pending orders',
    redPending?.orders.course === 180 &&
      redPending?.orders.eot === 'ahead_1' &&
      redPending?.orders.depth === 50,
  );
  check('sub orderedDepth rings up immediately', redPending?.orderedDepth === 50);
  check(
    'sub keel depth unchanged until resolve',
    redPending?.position?.depth === (gato.position as Json).depth,
  );
  check('umpire pending has station writer', Boolean(bluePending?.orders.updatedByStationId));
  check(
    'umpire pending roster names',
    Boolean(bluePending?.name && redPending?.name),
  );

  // 6. Lock + resolve
  const locked = await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  check('lock turn', locked.status === 200 && (locked.json.turn as Json).phase === 'locked');

  const before = runtime.requireGame(gameId);
  const blueBefore = before.units.find((u) => u.id === 'dd-101')!;
  const resolved = await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check('resolve turn', resolved.status === 200);
  check('turn advanced', (resolved.json.turn as Json).number === 2);
  check('phase open again', (resolved.json.turn as Json).phase === 'open');

  const after = runtime.requireGame(gameId);
  const blueAfter = after.units.find((u) => u.id === 'dd-101')!;
  check('orders cleared', Object.keys(blueAfter.orders).length === 0);
  check('heading changed or eot applied', blueAfter.eot === 'ahead_full' || blueAfter.heading !== blueBefore.heading);
  check('ordered course persists', blueAfter.orderedCourse === 45);
  check('heading turned toward ordered', blueAfter.heading !== blueBefore.heading || blueBefore.heading === 45);
  const redAfter = after.units.find((u) => u.id === 'ss-212')!;
  check('sub depth applied on resolve', redAfter.position.depth === 50);
  check('sub orderedDepth persists after resolve', redAfter.orderedDepth === 50);
  check('game clock advanced 5 min', after.turn.gameTimeSeconds === 28800 + 300);
  check('history snapshot', after.history.length === 1);
  check('history stores gameTime', after.history[0]!.gameTimeSeconds === 28800 + 300);
  const umpireAfter = await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken);
  const trails = (umpireAfter.json.view as Json).trails as Array<{ unitId: string; points: unknown[] }>;
  const porterTrail = trails.find((t) => t.unitId === 'dd-101');
  check('trail has origin + post-resolve', Boolean(porterTrail && porterTrail.points.length >= 2));

  await Promise.race([
    ssePromise,
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  check('SSE received versions', sseVersions.length >= 1, `got ${sseVersions.join(',')}`);
  sseAbort.abort();

  // 7. Save / reload
  const saved = await api('POST', `/api/games/${gameId}/save`, {}, umpireToken);
  check('manual save', saved.status === 200);

  // Submit more orders then rollback
  await api('POST', `/api/games/${gameId}/orders`, { course: 10 }, blueToken);

  const noConfirm = await api(
    'POST',
    `/api/games/${gameId}/rollback`,
    { turnNumber: 1 },
    umpireToken,
  );
  check('rollback rejects missing confirm', noConfirm.status === 400);

  const badConfirm = await api(
    'POST',
    `/api/games/${gameId}/rollback`,
    { turnNumber: 1, confirm: 'yes' },
    umpireToken,
  );
  check('rollback rejects weak confirm', badConfirm.status === 400);

  const rolled = await api(
    'POST',
    `/api/games/${gameId}/rollback`,
    { turnNumber: 1, confirm: 'ROLLBACK' },
    umpireToken,
  );
  check('rollback', rolled.status === 200);
  const rolledGame = runtime.requireGame(gameId);
  check('rollback clears orders', Object.keys(rolledGame.units.find((u) => u.id === 'dd-101')!.orders).length === 0);
  check('rollback turn number', rolledGame.turn.number === 2);

  // Resolve again then rollback with typed turn number
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterSecond = runtime.requireGame(gameId);
  check('second resolve turn', afterSecond.turn.number === 3);
  check('history has turn 2 snapshot', afterSecond.history.some((h) => h.turnNumber === 2));
  const rolled2 = await api(
    'POST',
    `/api/games/${gameId}/rollback`,
    { turnNumber: 2, confirm: '2' },
    umpireToken,
  );
  check('rollback via turn number confirm', rolled2.status === 200);
  check('rollback to T2 opens turn 3', runtime.requireGame(gameId).turn.number === 3);

  // Patch identity + migrate-style coerce
  const idPatch = await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { type: 'Aircraft', class: 'Destroyer' },
    umpireToken,
  );
  check('identity patch ok', idPatch.status === 200);
  const afterId = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('class wins over mismatched type', afterId.class === 'Destroyer' && afterId.type === 'Ship');

  // Class change refreshes historical maxSpeed default (Merchant 11 kn).
  const merchantPatch = await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { class: 'Merchant' },
    umpireToken,
  );
  check('merchant class patch ok', merchantPatch.status === 200);
  const asMerchant = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('merchant maxSpeed class default 11', asMerchant.maxSpeed === 11);
  check('merchant type Ship', asMerchant.type === 'Ship');

  // Faction patch + migrate-from-side behavior is covered by seed defaults;
  // also verify Civilian can be set and side stays in sync.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { faction: 'Civilian' },
    umpireToken,
  );
  const civ = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('faction Civilian', civ.faction === 'Civilian' && civ.side === 'civilian');
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { type: 'Ship', class: 'Destroyer', name: 'USS Porter', faction: 'Blue' },
    umpireToken,
  );
  const restoredDd = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('destroyer class restores 36 kn', restoredDd.maxSpeed === 36);

  // Umpire speed patch is clamped to ±maxSpeed
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { speed: 99 },
    umpireToken,
  );
  check(
    'speed patch clamped to maxSpeed',
    runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!.speed === 36,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { speed: -50 },
    umpireToken,
  );
  check(
    'reverse speed patch clamped',
    runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!.speed === -36,
  );
  // Class change with overspeed clamps to new class max
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { speed: 30, class: 'Merchant' },
    umpireToken,
  );
  const merchantOverspeed = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('class change clamps speed to 11', merchantOverspeed.speed === 11 && merchantOverspeed.maxSpeed === 11);
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { type: 'Ship', class: 'Destroyer', name: 'USS Porter', speed: 12 },
    umpireToken,
  );

  // Submerged submarine speed ceiling ~9 kn (hull maxSpeed stays 21).
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { speed: 18, position: { depth: 0 } },
    umpireToken,
  );
  check(
    'surfaced sub can hold 18 kn',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.speed === 18,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 40 } },
    umpireToken,
  );
  const dived = runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!;
  check('submerged clamps speed to 9', dived.speed === 9);
  check('hull maxSpeed unchanged while submerged', dived.maxSpeed === 21);
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { speed: 15, position: { depth: 40 } },
    umpireToken,
  );
  check(
    'submerged speed patch capped at 9',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.speed === 9,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 0 }, speed: 6 },
    umpireToken,
  );

  // Dive orders: presets + ship rejection + clamp
  const diveOrder = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { depth: 18 },
    redToken,
  );
  check('sub periscope depth order', diveOrder.status === 200);
  check(
    'periscope orderedDepth live',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth === 18,
  );
  check(
    'periscope keel still surface until resolve',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.position.depth === 0,
  );
  const shipDepthReject = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { depth: 40 },
    blueToken,
  );
  check('ship depth order rejected', shipDepthReject.status === 400);
  const deepClamp = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { depth: 250 },
    redToken,
  );
  check('depth order clamps to max', deepClamp.status === 200);
  check(
    'orderedDepth clamped to 100',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth === 100,
  );
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check(
    'clamped depth applied on resolve',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.position.depth === 100,
  );
  // Emergency blow → surface
  await api('POST', `/api/games/${gameId}/orders`, { depth: 0 }, redToken);
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check(
    'emergency blow / surface applied',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.position.depth === 0,
  );

  // Speed clamped to class max
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { speed: 99 },
    umpireToken,
  );
  const overSpeed = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('speed clamped to destroyer max', overSpeed.speed === overSpeed.maxSpeed && overSpeed.maxSpeed === 36);

  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { class: 'Fleet Submarine', type: 'Submarine', speed: 30 },
    umpireToken,
  );
  const asSub = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('class change adopts fleet sub maxSpeed', asSub.maxSpeed === 20);
  check('speed clamped after class change', asSub.speed === 20 && asSub.class === 'Fleet Submarine');
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { type: 'Ship', class: 'Destroyer', name: 'USS Porter', faction: 'Blue', speed: 12 },
    umpireToken,
  );

  // Ship depth forced to surface
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { position: { depth: 40 } },
    umpireToken,
  );
  check(
    'ship depth forced to 0',
    runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!.position.depth === 0,
  );

  // Sensors disabled → no radar picture
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { sensors: 'disabled' } },
    umpireToken,
  );
  const radarSensorsOff = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const rso = radarSensorsOff.json.view as Json;
  check('sensors disabled radar off', rso.radarOperational === false);
  check('sensors disabled reason', rso.radarUnavailableReason === 'sensors_disabled');

  // Propulsion disabled → stop
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { propulsion: 'disabled', sensors: 'intact' }, speed: 12 },
    umpireToken,
  );
  const deadInWater = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('propulsion disabled forces stop', deadInWater.speed === 0 && deadInWater.eot === 'stop');

  // Sunk clears as radar target
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { condition: 'sunk' },
    umpireToken,
  );
  const radarAfterSink = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  check(
    'sunk target not on radar',
    Array.isArray((radarAfterSink.json.view as Json).radarContacts) &&
      ((radarAfterSink.json.view as Json).radarContacts as unknown[]).length === 0,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { condition: 'afloat' },
    umpireToken,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { propulsion: 'intact', sensors: 'intact' }, speed: 12, eot: 'ahead_standard' },
    umpireToken,
  );

  // Momentum: ahead → reverse cannot cross zero in one resolve
  const ddFresh = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  ddFresh.speed = 8;
  ddFresh.eot = 'ahead_1';
  ddFresh.orders = {};
  await api('POST', `/api/games/${gameId}/orders`, { eot: 'back_full' }, blueToken);
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterReverseAttempt = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check(
    'momentum: reverse lands at stop (no zero-cross)',
    afterReverseAttempt.speed === 0 && afterReverseAttempt.eot === 'back_full',
  );
  // Next resolve gathers sternway
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterSternway = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('momentum: next turn gathers sternway', afterSternway.speed < 0);

  // Aircraft: loiter/cruise/full bands, never reverse; no player station auth
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    {
      type: 'Aircraft',
      class: 'Fighter',
      name: 'NPC Hellcat',
      speed: 100,
      eot: 'stop',
      maxSpeed: 320,
    },
    umpireToken,
  );
  const asFighter = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('aircraft class Fighter', asFighter.type === 'Aircraft' && asFighter.class === 'Fighter');
  const fighterLinks = (
    (await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken)).json.view as Json
  ).vesselLinks as Array<{ unitId: string; playerVessel?: boolean; stations: unknown[] }>;
  const fighterLink = fighterLinks.find((v) => v.unitId === 'dd-101');
  check('aircraft not player vessel', fighterLink?.playerVessel === false);
  check('aircraft has no station join links', Array.isArray(fighterLink?.stations) && fighterLink!.stations.length === 0);
  const npcAuth = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'blue',
    stationId: 'controls',
  });
  check('rejects non-player vessel station auth', npcAuth.status === 403);

  // Ring reverse on aircraft → loiter band (non-negative); step toward loiter
  asFighter.speed = 320;
  asFighter.eot = 'ahead_flank';
  asFighter.orders = { eot: 'back_full' };
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterAcReverse = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('aircraft speed stays non-negative', afterAcReverse.speed >= 0);
  check(
    'aircraft reverse maps toward loiter',
    afterAcReverse.speed < 320 && afterAcReverse.eot === 'back_full',
  );

  // Restore destroyer for remaining checks
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    {
      type: 'Ship',
      class: 'Destroyer',
      name: 'USS Porter',
      faction: 'Blue',
      speed: 12,
      eot: 'ahead_standard',
      maxSpeed: 36,
    },
    umpireToken,
  );

  // Bad password (game still in memory)
  const bad = await api('POST', `/api/games/${gameId}/auth/vessel`, {
    accessToken: 'porter-demo',
    password: 'wrong',
    stationId: 'controls',
  });
  check('rejects bad password', bad.status === 401);

  // Delete save — no orphans in memory or on disk
  const deleted = await api('DELETE', `/api/saves/${gameId}`);
  check('delete save', deleted.status === 200 && deleted.json.ok === true);
  check('delete unloaded memory', runtime.getGame(gameId) === undefined);
  const savesAfter = await api('GET', '/api/saves');
  const saveList = Array.isArray(savesAfter.json)
    ? (savesAfter.json as unknown as Array<{ id: string }>)
    : [];
  check('delete removed from list', !saveList.some((s) => s.id === gameId));

  // Disposable scenario delete (do not remove destroyer-sub-demo)
  const { writeScenario, deleteScenarioFile, loadScenario } = await import('./store/fileStore.js');
  const tempId = `verify-temp-${Date.now()}`;
  const demo = await loadScenario('destroyer-sub-demo');
  await writeScenario({
    ...demo,
    id: tempId,
    name: 'Verify Temp Scenario',
  });
  const listedSc = await api('GET', '/api/scenarios');
  const scList = Array.isArray(listedSc.json)
    ? (listedSc.json as unknown as Array<{ id: string }>)
    : [];
  check('temp scenario listed', scList.some((s) => s.id === tempId));
  const delSc = await api('DELETE', `/api/scenarios/${tempId}`);
  check('delete scenario', delSc.status === 200);
  const gone = await deleteScenarioFile(tempId);
  check('scenario file gone', gone === false);
  const listedSc2 = await api('GET', '/api/scenarios');
  const scList2 = Array.isArray(listedSc2.json)
    ? (listedSc2.json as unknown as Array<{ id: string }>)
    : [];
  check('scenario removed from list', !scList2.some((s) => s.id === tempId));

  // Ground-truth multi-turn stability (separate game; cleans up its save)
  const { runStabilityCheck } = await import('./stabilityCheck.js');
  const stab = await runStabilityCheck(base);
  results.push(...stab);
  check('stability suite ran', stab.length > 0);

  console.log('\n=== War Patrol Phase 1 verification ===');
  for (const line of results) console.log(line);
  console.log('ALL CHECKS PASSED');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
