/**
 * End-to-end verification script:
 * create → join two vessels → orders → lock → resolve → SSE stateVersion,
 * plus save/load and rollback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { runtime } from './game/runtime.js';
import {
  AIRCRAFT_INTERCEPT_DAMAGE,
  resolveAircraftAttackEffect,
  aircraftAttackModesForClass,
  canOrderAircraftAttack,
  isAircraftAttackTarget,
  CLASS_BEAM_M,
  CLASS_LENGTH_M,
  CLASS_MAX_SPEED_KNOTS,
  CLASS_SPEED_STEP_FRACTION,
  DEPTH_CHARGE_CONTROLS_AUDIBLE_NM,
  FLEET_SUB_CRUSH_DEPTH_M,
  FLEET_SUB_PATROL_DEPTH_M,
  FLEET_SUB_TEST_DEPTH_M,
  SUBMARINE_DEPTH_ORDER_STEP_M,
  SUBMARINE_DEPTH_RATE_M_PER_MIN,
  SUBMARINE_IMPLOSION_CHANCE_PER_TURN,
  SUBMARINE_MAX_DEPTH_M,
  SUBMERGED_MAX_SPEED_KNOTS,
  TORPEDO_SPREAD_MAX_DEG,
  TORPEDO_SPREAD_MIN_DEG,
  applyCrushDepthImplosions,
  bearingRangeNm,
  clampSpeedToMax,
  clampSubmarineDepth,
  coarsenActiveSonarDepthM,
  coarsenPeriscopeCourseDeg,
  coarsenPeriscopeRangeNm,
  coarsenPeriscopeSpeedKn,
  coarsenRelativeBearingDeg,
  editMaxSpeedForClass,
  effectiveMaxSpeed,
  ensureContactLabel,
  formatWallDuration,
  isPastCrushDepth,
  defaultTurnRateForClass,
  normalizeContactBook,
  parseWallDuration,
  quantizeSubmarineDepth,
  resolveBeamM,
  resolveLengthM,
  resolveMaxSpeed,
  resolveTurnRate,
  rollSubmarineImplosion,
  periscopeSilhouetteUrl,
  periscopeSilhouetteFlipX,
  silhouettePlateForClassId,
  silhouetteUrlForClass,
  silhouetteUrlForOptics,
  isV1PlayerHullClass,
  isV1PlayerUnit,
  isHydrophoneEmitter,
  isPeriscopeTargetable,
  controlsInstrumentTabsForHull,
  formatPendingOrdersSummary,
  snapWallDuration,
  stepDepthTowardOrdered,
  submarineDepthRisk,
  turnToward,
} from '@war-patrol/shared';
import { buildPeriscopeContacts } from './game/periscope.js';
import { buildRadarContacts } from './game/radar.js';

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
  // Periscope / lookout optics readouts are instrument-precise (ground truth)
  // — only whole-degree display rounding, not FoW banding.
  check('periscope course precise 90 stays 90', coarsenPeriscopeCourseDeg(90) === 90);
  check('periscope course precise 97 stays 97', coarsenPeriscopeCourseDeg(97) === 97);
  check('periscope course precise 98 stays 98', coarsenPeriscopeCourseDeg(98) === 98);
  check('periscope course precise 225 stays 225', coarsenPeriscopeCourseDeg(225) === 225);
  check('periscope course precise 359 stays 359', coarsenPeriscopeCourseDeg(359) === 359);
  check('periscope course precise 352 stays 352', coarsenPeriscopeCourseDeg(352) === 352);
  check(
    'periscope course rounds sub-degree noise (97.6 → 98)',
    coarsenPeriscopeCourseDeg(97.6) === 98,
  );
  check(
    'periscope range precise to 0.01 nm (12.344 → 12.34)',
    coarsenPeriscopeRangeNm(12.344) === 12.34,
  );
  check(
    'periscope range precise to 0.01 nm (12.346 → 12.35)',
    coarsenPeriscopeRangeNm(12.346) === 12.35,
  );
  check(
    'periscope speed precise to 0.1 kn (14.27 → 14.3)',
    coarsenPeriscopeSpeedKn(14.27) === 14.3,
  );
  check(
    'periscope relative bearing precise to 1° (12.6 → 13)',
    coarsenRelativeBearingDeg(12.6) === 13,
  );
  // Active sonar depth is 100% accurate (ground truth, whole-meter display
  // rounding) — surfaced gate only, no 25 m FoW banding.
  check('sonar depth surface band → 0', coarsenActiveSonarDepthM(0) === 0);
  check('sonar depth ≤5 m → 0', coarsenActiveSonarDepthM(5) === 0);
  check('sonar depth precise 10 m stays 10', coarsenActiveSonarDepthM(10) === 10);
  check('sonar depth precise 40 m stays 40', coarsenActiveSonarDepthM(40) === 40);
  check('sonar depth precise 50 m stays 50', coarsenActiveSonarDepthM(50) === 50);
  check('sonar depth precise 90 m stays 90', coarsenActiveSonarDepthM(90) === 90);
  check(
    'sonar depth rounds sub-meter noise (40.6 → 41)',
    coarsenActiveSonarDepthM(40.6) === 41,
  );
  check('parseWallDuration mm:ss', parseWallDuration('3:30') === 210);
  check('snapWallDuration 30s', snapWallDuration(200, 30) === 210);

  {
    const closeHit = resolveAircraftAttackEffect({
      mode: 'intercept',
      missDistanceM: 50,
      targetDepthM: 0,
      targetType: 'Ship',
      seed: 'ac-hit-seed',
    });
    check(
      'aircraft intercept close can damage',
      closeHit.outcome === 'hit' || closeHit.outcome === 'near_miss',
      `outcome=${closeHit.outcome} dmg=${closeHit.damage}`,
    );
    const deepGuns = resolveAircraftAttackEffect({
      mode: 'intercept',
      missDistanceM: 20,
      targetDepthM: 80,
      targetType: 'Submarine',
      seed: 'ac-deep',
    });
    check(
      'aircraft intercept ineffective vs deep sub',
      deepGuns.outcome === 'ineffective' && deepGuns.damage === 0,
    );
    const strafeDeep = resolveAircraftAttackEffect({
      mode: 'strafe',
      missDistanceM: 20,
      targetDepthM: 80,
      targetType: 'Submarine',
      seed: 'strafe-deep',
    });
    check(
      'aircraft strafe ineffective vs deep sub',
      strafeDeep.outcome === 'ineffective' && strafeDeep.damage === 0,
    );
    const strafeSurf = resolveAircraftAttackEffect({
      mode: 'strafe',
      missDistanceM: 40,
      targetDepthM: 0,
      targetType: 'Ship',
      seed: 'strafe-surf',
    });
    check(
      'aircraft strafe surface can damage like intercept',
      strafeSurf.outcome === 'hit' || strafeSurf.outcome === 'near_miss',
      `outcome=${strafeSurf.outcome} dmg=${strafeSurf.damage}`,
    );
    const bombHit = resolveAircraftAttackEffect({
      mode: 'bombing_run',
      missDistanceM: 40,
      targetDepthM: 0,
      targetType: 'Ship',
      seed: 'bomb-close-a',
    });
    check(
      'aircraft bombing close can damage',
      (bombHit.outcome === 'hit' && bombHit.damage > 0) || bombHit.outcome === 'near_miss',
      `outcome=${bombHit.outcome} dmg=${bombHit.damage}`,
    );
    check(
      'fighter attack modes lead with intercept',
      aircraftAttackModesForClass('Fighter')[0] === 'intercept',
    );
    check(
      'fighter attack modes include strafe',
      aircraftAttackModesForClass('Fighter').includes('strafe'),
    );
    check(
      'bomber attack modes lead with bombing run',
      aircraftAttackModesForClass('Bomber')[0] === 'bombing_run',
    );
    check(
      'aircraft can order attack when afloat',
      canOrderAircraftAttack({ type: 'Aircraft', condition: 'afloat' }),
    );
    check(
      'ships are aircraft attack targets',
      isAircraftAttackTarget({ type: 'Ship', condition: 'afloat' }),
    );
    check(
      'intercept damage constant museum-scale',
      AIRCRAFT_INTERCEPT_DAMAGE === 14,
    );
  }

  {
    const host: { contactBook?: { nextLabel: number; byTargetId: Record<string, number> } } = {};
    check('ensureContactLabel assigns Contact 1', ensureContactLabel(host, 't-a') === 1);
    check('ensureContactLabel assigns Contact 2', ensureContactLabel(host, 't-b') === 2);
    check('ensureContactLabel keeps Contact 1', ensureContactLabel(host, 't-a') === 1);
    check(
      'normalizeContactBook preserves labels',
      normalizeContactBook(host.contactBook)?.byTargetId['t-b'] === 2 &&
        normalizeContactBook(host.contactBook)?.nextLabel === 3,
    );
  }

  check('class max Destroyer 36', CLASS_MAX_SPEED_KNOTS.Destroyer === 36);
  check('class max Fleet Submarine 20', CLASS_MAX_SPEED_KNOTS['Fleet Submarine'] === 20);
  check('class max Fighter 320', CLASS_MAX_SPEED_KNOTS.Fighter === 320);
  check('class max Merchant 11', CLASS_MAX_SPEED_KNOTS.Merchant === 11);
  check('class length Fletcher Destroyer 115 m', CLASS_LENGTH_M.Destroyer === 115);
  check('class length Gato Fleet Sub 95 m', CLASS_LENGTH_M['Fleet Submarine'] === 95);
  check('class beam Fletcher Destroyer 12 m', CLASS_BEAM_M.Destroyer === 12);
  check('class beam Gato Fleet Sub 8.3 m', CLASS_BEAM_M['Fleet Submarine'] === 8.3);
  check(
    'resolveMaxSpeed prefers explicit',
    resolveMaxSpeed({ maxSpeed: 21, class: 'Fleet Submarine' }) === 21,
  );
  check(
    'resolveMaxSpeed class default',
    resolveMaxSpeed({ class: 'Battleship' }) === 33,
  );
  check(
    'resolveLengthM prefers explicit',
    resolveLengthM({ lengthM: 95, class: 'Destroyer' }) === 95,
  );
  check(
    'resolveLengthM class default',
    resolveLengthM({ class: 'Battleship' }) === 270,
  );
  check(
    'resolveBeamM prefers explicit',
    resolveBeamM({ beamM: 8.3, class: 'Destroyer' }) === 8.3,
  );
  check(
    'resolveBeamM class default',
    resolveBeamM({ class: 'Fighter' }) === 13,
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
  check('dive rate is 15 m/min', SUBMARINE_DEPTH_RATE_M_PER_MIN === 15);
  check('depth order step is 10 m', SUBMARINE_DEPTH_ORDER_STEP_M === 10);
  check('patrol depth 50 m', FLEET_SUB_PATROL_DEPTH_M === 50);
  check('test depth 90 m', FLEET_SUB_TEST_DEPTH_M === 90);
  check('crush depth 150 m', FLEET_SUB_CRUSH_DEPTH_M === 150);
  check('max depth past crush', SUBMARINE_MAX_DEPTH_M === 180);
  check('implosion chance 25%', SUBMARINE_IMPLOSION_CHANCE_PER_TURN === 0.25);
  check('quantize 94 → 90', quantizeSubmarineDepth(94) === 90);
  check('quantize 96 → 100', quantizeSubmarineDepth(96) === 100);
  check('clamp over max → 180', clampSubmarineDepth(250) === 180);
  check('at crush is not past', isPastCrushDepth(150) === false);
  check('past crush at 160', isPastCrushDepth(160) === true);
  check('risk below test', submarineDepthRisk(100) === 'below_test');
  check('risk at crush', submarineDepthRisk(150) === 'at_crush');
  check('risk past crush', submarineDepthRisk(160) === 'past_crush');
  check('implosion roll always when chance 1', rollSubmarineImplosion(() => 0.5, 1) === true);
  check('implosion roll never when chance 0', rollSubmarineImplosion(() => 0, 0) === false);
  check('implosion roll uses threshold', rollSubmarineImplosion(() => 0.2, 0.25) === true);
  check('implosion roll miss above chance', rollSubmarineImplosion(() => 0.3, 0.25) === false);
  {
    const units = [
      {
        id: 'ss-x',
        name: 'Testboat',
        type: 'Submarine' as const,
        class: 'Fleet Submarine' as const,
        condition: 'afloat' as const,
        health: 100,
        position: { lat: 0, lon: 0, depth: 160 },
        speed: 3,
        eot: 'ahead_standard' as const,
        heading: 0,
        orderedCourse: 0,
        orderedDepth: 160,
        subsystems: { propulsion: 'intact' as const, sensors: 'intact' as const },
        orders: {},
        maxSpeed: 21,
        turnRate: 12,
        radarSignature: 'small' as const,
        sensors: [],
        stations: [],
        side: 'red' as const,
        faction: 'Red' as const,
        periscopeRaised: false,
        periscopeExposure: 0,
        plotStampTurns: 0,
        activeSonarEnabled: false,
      },
    ];
    const boom = applyCrushDepthImplosions(units as never, {
      turnNumber: 3,
      gameTimeSeconds: 900,
      rng: () => 0.1,
      chance: 0.25,
    });
    check('implosion sinks past crush', boom.units[0]!.condition === 'sunk');
    check('implosion log kind', boom.combatLogEntries[0]?.kind === 'hull_implosion');
    const safe = applyCrushDepthImplosions(units as never, {
      turnNumber: 3,
      gameTimeSeconds: 900,
      rng: () => 0.9,
      chance: 0.25,
    });
    check('implosion miss keeps hull', safe.units[0]!.condition === 'afloat');
    const atCrush = applyCrushDepthImplosions(
      [{ ...units[0]!, position: { ...units[0]!.position, depth: 150 } }] as never,
      { turnNumber: 3, gameTimeSeconds: 900, rng: () => 0, chance: 1 },
    );
    check('exactly crush does not implode', atCrush.units[0]!.condition === 'afloat');
  }
  check(
    'depth steps 45 m toward ordered in 3-min turn',
    stepDepthTowardOrdered(0, 50, 180) === 45,
  );
  check(
    'depth does not overshoot ordered',
    stepDepthTowardOrdered(40, 50, 180) === 50,
  );
  check(
    'ascent steps toward surface',
    stepDepthTowardOrdered(90, 0, 180) === 45,
  );
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
  const scenarioStart = structuredClone(runtime.requireGame(gameId));
  const startPorter = scenarioStart.units.find((u) => u.id === 'dd-101')!;
  const startGato = scenarioStart.units.find((u) => u.id === 'ss-212')!;

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
  check(
    'radar contact has stable labelN',
    typeof contacts[0].labelN === 'number' && (contacts[0].labelN as number) >= 1,
    `got ${String(contacts[0].labelN)}`,
  );
  check('radar has max range', typeof rv.radarMaxRangeNm === 'number' && (rv.radarMaxRangeNm as number) > 0);
  const porter = (uv.units as Json[]).find((u) => u.id === 'dd-101')!;
  const gato = (uv.units as Json[]).find((u) => u.id === 'ss-212')!;
  check('destroyer radarSignature medium', porter.radarSignature === 'medium');
  check('sub radarSignature small', gato.radarSignature === 'small');
  check('porter type Ship', porter.type === 'Ship');
  check('porter class Destroyer', porter.class === 'Destroyer');
  check('porter maxSpeed Fletcher 36 kn', porter.maxSpeed === 36);
  check('porter lengthM Fletcher 115 m', porter.lengthM === 115);
  check('porter beamM Fletcher 12 m', porter.beamM === 12);
  check('porter faction Blue', porter.faction === 'Blue');
  check('porter afloat', porter.condition === 'afloat');
  check('porter propulsion intact', (porter.subsystems as Json).propulsion === 'intact');
  check('porter radar intact', (porter.subsystems as Json).radar === 'intact');
  check('porter steering intact', (porter.subsystems as Json).steering === 'intact');
  check('porter depth surface', (porter.position as Json).depth === 0);
  check('gato type Submarine', gato.type === 'Submarine');
  check('gato class Fleet Submarine', gato.class === 'Fleet Submarine');
  check('gato maxSpeed Gato 21 kn', gato.maxSpeed === 21);
  check('gato lengthM Gato 95 m', gato.lengthM === 95);
  check('gato beamM Gato 8.3 m', gato.beamM === 8.3);
  check('demo speeds distinct', (porter.maxSpeed as number) > (gato.maxSpeed as number));
  check(
    'vessel view omits hull dimensions',
    !('lengthM' in (bv.unit as Json)) && !('beamM' in (bv.unit as Json)),
  );
  check('gato faction Red', gato.faction === 'Red');
  check('gato afloat', gato.condition === 'afloat');
  check('destroyer turnRate (Fletcher, snappy)', porter.turnRate === 7);
  check('sub turnRate (Gato, between DD and capital ships)', gato.turnRate === 6);
  // Size-appropriate turning: large auxiliaries/capital ships must be strictly
  // slower to turn than a destroyer, and never as agile as the small-ship band
  // (Fighter/Bomber/legacy small, 12°/min). Fleet submarine sits in between.
  const oilerTurnRate = defaultTurnRateForClass('Oiler');
  const merchantTurnRate = defaultTurnRateForClass('Merchant');
  const destroyerTurnRate = defaultTurnRateForClass('Destroyer');
  const subTurnRate = defaultTurnRateForClass('Fleet Submarine');
  const cruiserTurnRate = defaultTurnRateForClass('Cruiser');
  const battleshipTurnRate = defaultTurnRateForClass('Battleship');
  const carrierTurnRate = defaultTurnRateForClass('Aircraft Carrier');
  check('oiler turnRate < destroyer turnRate', oilerTurnRate < destroyerTurnRate);
  check('merchant turnRate < destroyer turnRate', merchantTurnRate < destroyerTurnRate);
  check('oiler turnRate not small-ship band', oilerTurnRate < 12);
  check('merchant turnRate not small-ship band', merchantTurnRate < 12);
  check('cruiser turnRate not small-ship band', cruiserTurnRate < 12);
  check('battleship turnRate not small-ship band', battleshipTurnRate < 12);
  check('carrier turnRate not small-ship band', carrierTurnRate < 12);
  check('carrier turnRate capital-ship band (4°/min)', carrierTurnRate === 4);
  check(
    'carrier turnRate matches Essex/Shōkaku library default',
    resolveTurnRate({ class: 'Aircraft Carrier' }) === 4 &&
      resolveTurnRate({ class: 'Aircraft Carrier', turnRate: 4 }) === 4,
  );
  check(
    'Aircraft Carrier is not a v1 player hull (NPC only)',
    !isV1PlayerHullClass('Aircraft Carrier'),
  );
  check(
    'sub turnRate between destroyer and capital ships',
    subTurnRate < destroyerTurnRate && subTurnRate > cruiserTurnRate,
  );
  check(
    'oiler turnRate matches library/class default (Cimarron)',
    resolveTurnRate({ class: 'Oiler' }) === oilerTurnRate,
  );
  check('orderedCourse seeded to heading (porter)', porter.orderedCourse === porter.heading);
  check(
    'orderedDepth seeded to position (gato)',
    gato.orderedDepth === (gato.position as Json).depth,
  );
  check('orderedDepth ship is 0', porter.orderedDepth === 0);
  check('game clock starts 08:00', (uv.turn as Json).gameTimeSeconds === 28800);
  check('turn length 3 min', uv.turnLengthSeconds === 180);
  check('order timer default 3 min', (uv.turn as Json).timerSeconds === 180);
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
          (s.capabilities as string[]).includes('active_sonar') &&
          (s.capabilities as string[]).includes('lookout'),
      ),
  );
  {
    const ddTabs = controlsInstrumentTabsForHull('Destroyer').map((t) => t.id);
    const subTabs = controlsInstrumentTabsForHull('Fleet Submarine').map((t) => t.id);
    check(
      'destroyer Controls tabs: Guns + Depth charges (no Weapons lump)',
      ddTabs.includes('guns') &&
        ddTabs.includes('depth_charges') &&
        !ddTabs.includes('torpedoes') &&
        !ddTabs.some((id) => String(id) === 'weapons'),
    );
    check(
      'sub Controls tabs: Torpedoes + Guns (no Depth charges / Weapons lump)',
      subTabs.includes('torpedoes') &&
        subTabs.includes('guns') &&
        !subTabs.includes('depth_charges') &&
        !subTabs.some((id) => String(id) === 'weapons'),
    );
    check(
      'Controls tab labels stay first-class weapon names',
      controlsInstrumentTabsForHull('Destroyer').some((t) => t.id === 'guns' && t.label === 'Guns') &&
        controlsInstrumentTabsForHull('Destroyer').some(
          (t) => t.id === 'depth_charges' && t.label === 'Depth charges',
        ) &&
        controlsInstrumentTabsForHull('Fleet Submarine').some(
          (t) => t.id === 'torpedoes' && t.label === 'Torpedoes',
        ),
    );
    check(
      'DC pair pending summary is PAIR not PAIR4',
      formatPendingOrdersSummary({
        dropDepthCharges: { pattern: 'pair', depthSettingM: 50 },
      }).includes('DC PAIR ·') &&
        !formatPendingOrdersSummary({
          dropDepthCharges: { pattern: 'pair', depthSettingM: 50 },
        }).includes('PAIR4'),
    );
  }
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
    'destroyer has lookout sensor',
    Array.isArray(porter.sensors) &&
      (porter.sensors as Json[]).some((s) => s.kind === 'lookout'),
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

  // 3c. Destroyer Sensors: active sonar toggle + forward cone + lookout (no hydrophone)
  check('destroyer sensors has sonar fields', typeof rv.sonarOperational === 'boolean');
  check('sonar off by default', rv.sonarOperational === false);
  check('sonar off reason', rv.sonarUnavailableReason === 'sonar_off');
  check('sonar half-angle stub', rv.sonarHalfAngleDeg === 30);
  check(
    'sonar max range stub',
    typeof rv.sonarMaxRangeNm === 'number' && (rv.sonarMaxRangeNm as number) === 8,
  );
  check('destroyer sensors has no hydrophone picture', !('hydrophoneContacts' in rv));
  check('destroyer lookout live', rv.periscopeOperational === true);
  check('destroyer lookout has contacts array', Array.isArray(rv.periscopeContacts));
  check(
    'destroyer lookout max range stub',
    typeof rv.periscopeMaxRangeNm === 'number' && (rv.periscopeMaxRangeNm as number) === 6,
  );
  {
    const ddLookoutContacts = rv.periscopeContacts as Array<Json>;
    check(
      'destroyer lookout sees sub on surface',
      ddLookoutContacts.length >= 1,
      `got ${ddLookoutContacts.length}`,
    );
    if (ddLookoutContacts[0]) {
      check(
        'destroyer lookout contact FoW fields',
        typeof ddLookoutContacts[0].relativeBearing === 'number' &&
          typeof ddLookoutContacts[0].rangeNm === 'number' &&
          typeof ddLookoutContacts[0].speedKn === 'number' &&
          typeof ddLookoutContacts[0].courseDeg === 'number' &&
          ddLookoutContacts[0].silhouetteClass === 'Fleet Submarine' &&
          !('side' in ddLookoutContacts[0]) &&
          !('name' in ddLookoutContacts[0]) &&
          !('position' in ddLookoutContacts[0]),
      );
      check(
        'destroyer lookout precise course',
        ddLookoutContacts[0].courseDeg === 225,
        `got ${ddLookoutContacts[0].courseDeg}`,
      );
    }
  }

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
    // Dead ahead of Porter (hdg 090) from demo start lat/lon; inside active-sonar stub range.
    { position: { lat: 34.38464, lon: -119.93226, depth: 40 } },
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
  check(
    'sonar contact estimated depth is precise GT',
    // Active sonar is 100% accurate — Gato placed at depth 40 reads exactly 40.
    sonarContacts[0].estimatedDepthM === 40,
    `got ${sonarContacts[0].estimatedDepthM}`,
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
  check('sub periscope down by default', sss.periscopeOperational === false);
  check('sub periscope reason scope_down', sss.periscopeUnavailableReason === 'scope_down');
  check('sub periscope raised flag false', (sss.unit as Json).periscopeRaised === false);
  check('sub periscope exposure zero when down', (sss.unit as Json).periscopeExposure === 0);
  check('sub periscope has contacts array', Array.isArray(sss.periscopeContacts));
  check(
    'sub periscope max range stub',
    typeof sss.periscopeMaxRangeNm === 'number' && (sss.periscopeMaxRangeNm as number) === 6,
  );

  // Demo start places Porter ~3 nm from Gato (inside 6 nm lookout stub) — no PATCH required.
  {
    const demoPorter = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
    const demoGato = runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!;
    const { rangeNm: demoRange } = bearingRangeNm(demoGato.position, demoPorter.position);
    check(
      'demo start within periscope range',
      demoRange <= 6,
      `got ${demoRange.toFixed(2)} nm`,
    );
  }

  // Raise mast — optics live; scope down cleared contacts.
  const raisePeri = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: true },
    subSensorsToken,
  );
  check('raise periscope on surface', raisePeri.status === 200);
  check('raise returns raised true', raisePeri.json.periscopeRaised === true);
  check(
    'raise defaults full exposure',
    raisePeri.json.periscopeExposure === 1,
    `got ${raisePeri.json.periscopeExposure}`,
  );

  const periSurf = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const periSurfView = periSurf.json.view as Json;
  check('sub periscope live when raised', periSurfView.periscopeOperational === true);
  const periContacts = periSurfView.periscopeContacts as Array<Json>;
  check('sub periscope sees destroyer on surface', periContacts.length >= 1, `got ${periContacts.length}`);
  check(
    'periscope contact relative bearing + range + speed',
    typeof periContacts[0].relativeBearing === 'number' &&
      typeof periContacts[0].rangeNm === 'number' &&
      typeof periContacts[0].speedKn === 'number' &&
      typeof periContacts[0].courseDeg === 'number',
  );
  check(
    'periscope contact precise course',
    periContacts[0].courseDeg === 90,
    `got ${periContacts[0].courseDeg}`,
  );
  // Optics readouts are ground-truth precise (display-rounded to the nearest
  // degree) — off-grid headings should read through exactly, not band to 15°.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { heading: 97 },
    umpireToken,
  );
  const periCourseExact = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const periExactContacts = (periCourseExact.json.view as Json).periscopeContacts as Array<Json>;
  check(
    'periscope course reads exact off-grid heading',
    periExactContacts[0]?.courseDeg === 97,
    `got ${periExactContacts[0]?.courseDeg}`,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { heading: 90 },
    umpireToken,
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
    'periscope contact has stable labelN',
    typeof periContacts[0].labelN === 'number' && (periContacts[0].labelN as number) >= 1,
  );
  {
    const radarOnSurf = periSurfView.radarContacts as Array<Json>;
    check(
      'radar+periscope share Contact N for same hull',
      Array.isArray(radarOnSurf) &&
        radarOnSurf.length >= 1 &&
        radarOnSurf[0].labelN === periContacts[0].labelN,
      `radar=${String(radarOnSurf?.[0]?.labelN)} peri=${String(periContacts[0].labelN)}`,
    );
  }
  check(
    'destroyer silhouette asset path',
    silhouetteUrlForClass('Destroyer') === '/silhouettes/destroyer.png',
  );
  check(
    'submarine silhouette asset path',
    silhouetteUrlForClass('Fleet Submarine') === '/silhouettes/submarine.png',
  );
  check(
    'oiler silhouette asset path',
    silhouetteUrlForClass('Oiler') === '/silhouettes/oiler.png',
  );
  check(
    'carrier silhouette asset path',
    silhouetteUrlForClass('Aircraft Carrier') === '/silhouettes/carrier.png',
  );
  check(
    'kagero plate stem from classId',
    silhouettePlateForClassId('kagero-class') === 'kagero' &&
      silhouettePlateForClassId('fletcher-class') === undefined,
  );
  check(
    'zeke plate stem from classId',
    silhouettePlateForClassId('zeke-fighter') === 'zeke' &&
      silhouettePlateForClassId('hellcat-fighter') === undefined,
  );
  check(
    'kagero optics plate distinct from Fletcher destroyer',
    silhouetteUrlForOptics({ hullClass: 'Destroyer', classId: 'kagero-class' }) ===
      '/silhouettes/kagero.png' &&
      silhouetteUrlForOptics({ hullClass: 'Destroyer', classId: 'fletcher-class' }) ===
        '/silhouettes/destroyer.png' &&
      periscopeSilhouetteUrl('Destroyer', { classId: 'kagero-class' }) ===
        '/silhouettes/kagero.png',
  );
  check(
    'zeke optics plate for Fighter classId',
    silhouetteUrlForOptics({ hullClass: 'Fighter', classId: 'zeke-fighter' }) ===
      '/silhouettes/zeke.png' &&
      silhouetteUrlForOptics({ hullClass: 'Fighter', classId: 'hellcat-fighter' }) === null &&
      periscopeSilhouetteUrl('Fighter', { classId: 'zeke-fighter' }) ===
        '/silhouettes/zeke.png' &&
      periscopeSilhouetteUrl('Fighter') === '/silhouettes/destroyer.png',
  );
  check(
    'periscope silhouette class map + destroyer fallback',
    periscopeSilhouetteUrl('Fleet Submarine') === '/silhouettes/submarine.png' &&
      periscopeSilhouetteUrl('Destroyer') === '/silhouettes/destroyer.png' &&
      periscopeSilhouetteUrl('Oiler') === '/silhouettes/oiler.png' &&
      periscopeSilhouetteUrl('Aircraft Carrier') === '/silhouettes/carrier.png' &&
      periscopeSilhouetteUrl(undefined) === '/silhouettes/destroyer.png' &&
      periscopeSilhouetteUrl('Merchant') === '/silhouettes/destroyer.png',
  );
  // Bow-right plates: starboard AOB unflipped; port AOB flipped. Own HDG north.
  // Target eastbound (090°) dead ahead (rel 0): observer is south of target → stbd aspect.
  check(
    'silhouette flip: stbd beam ahead of eastbound → no flip',
    periscopeSilhouetteFlipX(0, 0, 90) === false,
  );
  // Target westbound (270°) dead ahead: observer is south → port aspect.
  check(
    'silhouette flip: port beam ahead of westbound → flip',
    periscopeSilhouetteFlipX(0, 0, 270) === true,
  );
  // Target northbound, contact to starboard (rel +90, true 090): observer west of target → port.
  check(
    'silhouette flip: northbound target to stbd → port aspect flip',
    periscopeSilhouetteFlipX(0, 90, 0) === true,
  );
  // Same geometry from south heading: rel −90 → true 090, still port aspect.
  check(
    'silhouette flip: same LOS from HDG 180 → still flip',
    periscopeSilhouetteFlipX(180, -90, 0) === true,
  );
  check(
    'silhouette flip: missing course (feather) → no flip',
    periscopeSilhouetteFlipX(0, 45, undefined) === false,
  );
  {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pngHasTransparency = (buf: Buffer): boolean => {
      // Indexed/gray: optional tRNS. Truecolor/gray with alpha: IHDR color type 4 or 6.
      if (buf.includes(Buffer.from('tRNS'))) return true;
      const ihdr = buf.indexOf(Buffer.from('IHDR'));
      if (ihdr < 0 || ihdr + 17 > buf.length) return false;
      const colorType = buf[ihdr + 13]; // bit depth @ +12, color type @ +13 after 'IHDR'
      return colorType === 4 || colorType === 6;
    };
    const assertSilhouettePng = (name: string, minBytes: number) => {
      const candidates = [
        path.resolve(here, `../../client/public/silhouettes/${name}`),
        path.resolve(here, `../../../client/public/silhouettes/${name}`),
      ];
      const resolved = candidates.find((p) => fs.existsSync(p));
      const buf = resolved ? fs.readFileSync(resolved) : null;
      // PNG signature + tRNS (indexed alpha) or RGBA/gray+A — keep transparency for optics.
      const isPng = Boolean(
        buf &&
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47,
      );
      const hasAlpha = Boolean(buf && pngHasTransparency(buf));
      check(
        `${name.replace('.png', '')} silhouette PNG present`,
        isPng && Boolean(buf && buf.length > minBytes) && hasAlpha,
        resolved ? `${resolved} ${buf?.length ?? 0} bytes alpha=${hasAlpha}` : 'missing',
      );
      // After `pnpm build`, Vite copies public/ → client/dist/; production serves dist.
      const distCandidates = [
        path.resolve(here, `../../client/dist/silhouettes/${name}`),
        path.resolve(here, `../../../client/dist/silhouettes/${name}`),
      ];
      const distPng = distCandidates.find((p) => fs.existsSync(p));
      if (distPng) {
        const distBuf = fs.readFileSync(distPng);
        const distIsPng =
          distBuf[0] === 0x89 &&
          distBuf[1] === 0x50 &&
          distBuf[2] === 0x4e &&
          distBuf[3] === 0x47;
        const distAlpha = pngHasTransparency(distBuf);
        check(
          `${name.replace('.png', '')} silhouette in client dist`,
          distIsPng && distBuf.length > minBytes && distAlpha,
          `${distPng} ${distBuf.length} bytes alpha=${distAlpha}`,
        );
      }
    };
    assertSilhouettePng('destroyer.png', 1000);
    assertSilhouettePng('submarine.png', 1000);
    assertSilhouettePng('oiler.png', 1000);
    assertSilhouettePng('carrier.png', 1000);
    assertSilhouettePng('kagero.png', 1000);
    assertSilhouettePng('zeke.png', 1000);
  }
  check(
    'controls has no periscope picture',
    !('periscopeContacts' in bv) || bv.periscopeContacts === undefined,
  );

  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 20 } },
    umpireToken,
  );
  const periAt18 = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  check(
    'sub periscope operational at 20 m when raised',
    (periAt18.json.view as Json).periscopeOperational === true,
  );

  // Lower mast → optically blind; plot stamp resets.
  const lowerPeri = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: false },
    subSensorsToken,
  );
  check('lower periscope', lowerPeri.status === 200);
  check('lower resets plot stamp', lowerPeri.json.plotStampTurns === 0);
  check('lower zeros exposure', lowerPeri.json.periscopeExposure === 0);
  const periDown = await api('GET', `/api/games/${gameId}/view`, undefined, subSensorsToken);
  const periDownView = periDown.json.view as Json;
  check('sub periscope blind when down', periDownView.periscopeOperational === false);
  check('sub periscope reason scope_down at depth', periDownView.periscopeUnavailableReason === 'scope_down');
  check(
    'scope down clears contacts',
    Array.isArray(periDownView.periscopeContacts) &&
      (periDownView.periscopeContacts as Json[]).length === 0,
  );

  // Raise again then dive deep — auto unavailable too_deep; raise rejected.
  await api('POST', `/api/games/${gameId}/periscope`, { raised: true }, subSensorsToken);
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
  const raiseDeep = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: true },
    subSensorsToken,
  );
  check('raise rejected when too deep', raiseDeep.status === 400);

  // DD lookout spots raised periscope feather (not full hull) when sub at peri depth.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { lat: 34.35, lon: -120.05, depth: 20 }, speed: 3 },
    umpireToken,
  );
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { position: { lat: 34.35, lon: -120.1 }, speed: 12 },
    umpireToken,
  );
  // Mast still marked raised from earlier; depth now allows raise — re-raise after dive.
  const raiseAtPeri = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: true, exposure: 1 },
    subSensorsToken,
  );
  check('raise at periscope depth', raiseAtPeri.status === 200);
  check('raise at peri sets exposure', raiseAtPeri.json.periscopeExposure === 1);
  const ddLookFeather = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const ddFeatherView = ddLookFeather.json.view as Json;
  const featherContacts = (ddFeatherView.periscopeContacts as Array<Json>) ?? [];
  const feather = featherContacts.find((c) => c.kind === 'periscope');
  // Deterministic — exposed mast in range always paints the feather.
  check('DD lookout always sees exposed periscope feather', Boolean(feather));
  if (feather) {
    check(
      'DD lookout periscope feather FoW',
      feather.silhouetteClass === 'Fleet Submarine' &&
        feather.speedKn === 0 &&
        typeof feather.relativeBearing === 'number' &&
        typeof feather.rangeNm === 'number' &&
        !('courseDeg' in feather) &&
        !('name' in feather),
    );
  }
  // Peek exposure still raised → still visible (exposure is duration choice, not RNG).
  const setPeek = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: true, exposure: 0.2 },
    subSensorsToken,
  );
  check('set peek exposure', setPeek.status === 200 && setPeek.json.periscopeExposure === 0.2);
  const ddPeekFeather = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const peekFeathers =
    ((ddPeekFeather.json.view as Json).periscopeContacts as Array<Json>) ?? [];
  check(
    'peek exposure still paints feather',
    peekFeathers.some((c) => c.kind === 'periscope'),
  );
  // Scope down → not spottable as feather.
  await api('POST', `/api/games/${gameId}/periscope`, { raised: false }, subSensorsToken);
  const ddNoFeather = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const noFeather = ((ddNoFeather.json.view as Json).periscopeContacts as Array<Json>) ?? [];
  check(
    'scope down not spottable as periscope',
    !noFeather.some((c) => c.kind === 'periscope'),
  );

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
  check(
    'sub depth stepped toward ordered on resolve',
    redAfter.position.depth === 45 && redAfter.orderedDepth === 50,
  );
  check('sub orderedDepth persists after resolve', redAfter.orderedDepth === 50);
  check('game clock advanced 3 min', after.turn.gameTimeSeconds === 28800 + 180);
  check('history snapshot', after.history.length === 1);
  check('history stores gameTime', after.history[0]!.gameTimeSeconds === 28800 + 180);
  const umpireAfter = await api('GET', `/api/games/${gameId}/view`, undefined, umpireToken);
  const trails = (umpireAfter.json.view as Json).trails as Array<{ unitId: string; points: unknown[] }>;
  const porterTrail = trails.find((t) => t.unitId === 'dd-101');
  check('trail has origin + post-resolve', Boolean(porterTrail && porterTrail.points.length >= 2));

  // Concurrent resolve must serialize per game (no overlapping stale overwrite).
  // After the first lands in `open`, the second force-resolves from open → +2 turns.
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  const turnBeforeRace = runtime.requireGame(gameId).turn.number;
  const historyBeforeRace = runtime.requireGame(gameId).history.length;
  const [raceA, raceB] = await Promise.all([
    api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken),
    api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken),
  ]);
  check('concurrent resolve A ok', raceA.status === 200);
  check('concurrent resolve B ok', raceB.status === 200);
  const afterRace = runtime.requireGame(gameId);
  check(
    'concurrent resolve serializes both advances',
    afterRace.turn.number === turnBeforeRace + 2,
    `before=${turnBeforeRace} after=${afterRace.turn.number}`,
  );
  check(
    'concurrent resolve history consistent',
    afterRace.history.length === historyBeforeRace + 2,
  );

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
  const rolledPorter = rolledGame.units.find((u) => u.id === 'dd-101')!;
  const rolledGato = rolledGame.units.find((u) => u.id === 'ss-212')!;
  const endPorter = after.history[0]?.units.find((u) => u.id === 'dd-101');
  check('rollback clears orders', Object.keys(rolledPorter.orders).length === 0);
  check('rollback to T1 reopens turn 1', rolledGame.turn.number === 1 && rolledGame.turn.phase === 'open');
  check(
    'rollback to T1 restores start clock',
    rolledGame.turn.gameTimeSeconds === scenarioStart.turn.gameTimeSeconds,
  );
  check('rollback to T1 drops resolved history', rolledGame.history.length === 0);
  check(
    'turn 1 resolve moved Porter',
    Boolean(endPorter && endPorter.position.lon !== startPorter.position.lon),
  );
  check(
    'rollback to T1 restores Porter position',
    rolledPorter.position.lat === startPorter.position.lat &&
      rolledPorter.position.lon === startPorter.position.lon &&
      rolledPorter.position.depth === startPorter.position.depth,
  );
  check(
    'rollback to T1 restores Porter kinematics',
    rolledPorter.heading === startPorter.heading &&
      rolledPorter.speed === startPorter.speed &&
      rolledPorter.eot === startPorter.eot &&
      rolledPorter.orderedCourse === startPorter.orderedCourse,
  );
  check(
    'rollback to T1 restores Porter orders',
    Object.keys(rolledPorter.orders).length === 0 &&
      Object.keys(startPorter.orders).length === 0,
  );
  check(
    'rollback to T1 restores Gato position',
    rolledGato.position.lat === startGato.position.lat &&
      rolledGato.position.lon === startGato.position.lon &&
      rolledGato.position.depth === startGato.position.depth,
  );
  check(
    'rollback to T1 restores Gato orders',
    Object.keys(rolledGato.orders).length === 0 &&
      rolledGato.orderedDepth === startGato.orderedDepth &&
      rolledGato.heading === startGato.heading &&
      rolledGato.speed === startGato.speed &&
      rolledGato.eot === startGato.eot,
  );

  // Re-resolve turn 1 and turn 2, then rollback to end of T2
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check('resolve after T1 rollback opens turn 2', runtime.requireGame(gameId).turn.number === 2);
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
  check('merchant lengthM class default 135', asMerchant.lengthM === 135);
  check('merchant beamM class default 17', asMerchant.beamM === 17);
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

  // --- Umpire course override: gradual turn + persistence (Wade oiler reverse) ---
  // Seed bow + standing course east, then umpire rings up reverse without snapping.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { heading: 90, speed: 12 },
    umpireToken,
  );
  // Stale station helm order that would otherwise reassert 090 on resolve.
  await api('POST', `/api/games/${gameId}/orders`, { course: 90 }, blueToken);
  const courseBefore = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('pre-course-override heading 090', Math.abs(courseBefore.heading - 90) < 0.01);
  check(
    'pre-course-override pending CRS 090',
    courseBefore.orders?.course === 90,
  );
  const coursePatch = await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { orderedCourse: 270 },
    umpireToken,
  );
  check('umpire orderedCourse patch ok', coursePatch.status === 200);
  const courseApplied = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check(
    'umpire course does not snap heading',
    Math.abs(courseApplied.heading - 90) < 0.01,
    `hdg=${courseApplied.heading}`,
  );
  check(
    'umpire course sets standing orderedCourse',
    Math.abs(courseApplied.orderedCourse - 270) < 0.01,
    `crs=${courseApplied.orderedCourse}`,
  );
  check(
    'umpire course clears stale pending helm CRS',
    courseApplied.orders?.course === undefined,
    `pending=${courseApplied.orders?.course}`,
  );
  const turnLen = runtime.requireGame(gameId).turnLengthSeconds ?? 180;
  const maxYaw = courseApplied.turnRate * (turnLen / 60);
  const expectedHdg = turnToward(90, 270, maxYaw);
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const courseAfter = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check(
    'umpire course persists after resolve',
    Math.abs(courseAfter.orderedCourse - 270) < 0.01,
    `crs=${courseAfter.orderedCourse}`,
  );
  check(
    'umpire course turns gradually (not snap, not revert to 090)',
    Math.abs(courseAfter.heading - expectedHdg) < 0.05,
    `hdg=${courseAfter.heading} want≈${expectedHdg} (from 90 toward 270, Δ≤${maxYaw})`,
  );
  check(
    'umpire course heading left 090',
    Math.abs(courseAfter.heading - 90) > 1,
    `hdg=${courseAfter.heading}`,
  );
  // Fiat heading patch still teleports bow but also retargets orderedCourse (no drift-back).
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { heading: 45 },
    umpireToken,
  );
  const fiatHdg = runtime.requireGame(gameId).units.find((u) => u.id === 'dd-101')!;
  check('fiat heading snaps bow', Math.abs(fiatHdg.heading - 45) < 0.01);
  check(
    'fiat heading retargets orderedCourse',
    Math.abs(fiatHdg.orderedCourse - 45) < 0.01,
    `crs=${fiatHdg.orderedCourse}`,
  );
  // Restore porter eastbound for later tests.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { heading: 90, speed: 12 },
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
    { depth: 20 },
    redToken,
  );
  check('sub periscope depth order', diveOrder.status === 200);
  check(
    'periscope orderedDepth live',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth === 20,
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
  const coarseOrder = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { depth: 94 },
    redToken,
  );
  check('coarse depth order accepted', coarseOrder.status === 200);
  check(
    'orderedDepth quantized to 10 m',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth === 90,
  );
  const deepClamp = await api(
    'POST',
    `/api/games/${gameId}/orders`,
    { depth: 250 },
    redToken,
  );
  check('depth order clamps to max', deepClamp.status === 200);
  check(
    'orderedDepth clamped to max (past crush allowed)',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth ===
      SUBMARINE_MAX_DEPTH_M,
  );
  // Do not resolve at max (past crush rolls implosion RNG). Dive to test depth instead.
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 45 } },
    umpireToken,
  );
  await api('POST', `/api/games/${gameId}/orders`, { depth: 90 }, redToken);
  check(
    'test-depth order after clamp',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.orderedDepth === 90,
  );
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterDeepDive = runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!;
  check(
    'depth stepped to test band',
    afterDeepDive.position.depth === 90 && afterDeepDive.orderedDepth === 90,
  );
  // Emergency blow → surface (standing ordered 0; keel approaches over resolves)
  await api('POST', `/api/games/${gameId}/orders`, { depth: 0 }, redToken);
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check(
    'emergency blow ascent first resolve',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.position.depth === 45,
  );
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  check(
    'emergency blow / surface reached ordered',
    runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!.position.depth === 0,
  );

  // Dive past periscope depth on resolve auto-lowers mast
  await api(
    'PATCH',
    `/api/games/${gameId}/units/ss-212`,
    { position: { depth: 20 } },
    umpireToken,
  );
  const raiseForDive = await api(
    'POST',
    `/api/games/${gameId}/periscope`,
    { raised: true },
    subSensorsToken,
  );
  check('raise before deep dive', raiseForDive.status === 200 && raiseForDive.json.periscopeRaised === true);
  await api('POST', `/api/games/${gameId}/orders`, { depth: 50 }, redToken);
  await api('POST', `/api/games/${gameId}/turn/lock`, {}, umpireToken);
  await api('POST', `/api/games/${gameId}/turn/resolve`, {}, umpireToken);
  const afterAutoLower = runtime.requireGame(gameId).units.find((u) => u.id === 'ss-212')!;
  check(
    'dive past peri depth auto-lowers mast',
    afterAutoLower.position.depth === 50 &&
      afterAutoLower.periscopeRaised === false &&
      afterAutoLower.periscopeExposure === 0,
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

  // Radar station knocked out → no radar picture (lookout still up on DD)
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { radar: 'disabled' } },
    umpireToken,
  );
  const radarSensorsOff = await api('GET', `/api/games/${gameId}/view`, undefined, radarToken);
  const rso = radarSensorsOff.json.view as Json;
  check('radar disabled radar off', rso.radarOperational === false);
  check('radar disabled reason', rso.radarUnavailableReason === 'sensors_disabled');
  check(
    'DD lookout immune to radar casualty',
    rso.periscopeOperational === true,
    `got operational=${String(rso.periscopeOperational)} reason=${String(rso.periscopeUnavailableReason)}`,
  );

  // Legacy sensors:disabled expands to all stations (lookout still immune on DD)
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { sensors: 'disabled', radar: 'intact', activeSonar: 'intact' } },
    umpireToken,
  );

  // Propulsion disabled → stop
  await api(
    'PATCH',
    `/api/games/${gameId}/units/dd-101`,
    { subsystems: { propulsion: 'disabled', radar: 'intact' }, speed: 12 },
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
    { subsystems: { propulsion: 'intact', radar: 'intact' }, speed: 12, eot: 'ahead_standard' },
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
  check(
    'fighter is not a hydrophone emitter',
    isHydrophoneEmitter(asFighter) === false,
  );
  check(
    'bomber is not a hydrophone emitter',
    isHydrophoneEmitter({ type: 'Aircraft', condition: 'afloat', speed: 250 }) === false,
  );
  check(
    'fighter is optically targetable (lookout/peri)',
    isPeriscopeTargetable(asFighter) === true,
  );
  check(
    'bomber is optically targetable (lookout/peri)',
    isPeriscopeTargetable({
      type: 'Aircraft',
      condition: 'afloat',
      position: { lat: 0, lon: 0, depth: 0 },
    }) === true,
  );
  check(
    'destroyed aircraft not optically targetable',
    isPeriscopeTargetable({
      type: 'Aircraft',
      condition: 'sunk',
      position: { lat: 0, lon: 0, depth: 0 },
    }) === false,
  );
  check(
    'underway destroyer is a hydrophone emitter',
    isHydrophoneEmitter({ type: 'Ship', condition: 'afloat', speed: 12 }) === true,
  );
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

  // Delete all saves — wipe remaining disk saves + unload memory
  const extraA = await api('POST', '/api/games', { scenarioId: 'destroyer-sub-demo', name: 'Wipe A' });
  const extraB = await api('POST', '/api/games', { scenarioId: 'destroyer-sub-demo', name: 'Wipe B' });
  check('delete-all seed A', extraA.status === 200 && typeof extraA.json.gameId === 'string');
  check('delete-all seed B', extraB.status === 200 && typeof extraB.json.gameId === 'string');
  const wipeIdA = String(extraA.json.gameId);
  const wipeIdB = String(extraB.json.gameId);
  const wiped = await api('DELETE', '/api/saves');
  check(
    'delete all saves',
    wiped.status === 200 &&
      wiped.json.ok === true &&
      typeof wiped.json.deleted === 'number' &&
      (wiped.json.deleted as number) >= 2,
  );
  check('delete all unloaded A', runtime.getGame(wipeIdA) === undefined);
  check('delete all unloaded B', runtime.getGame(wipeIdB) === undefined);
  const savesWiped = await api('GET', '/api/saves');
  const wipedList = Array.isArray(savesWiped.json)
    ? (savesWiped.json as unknown as Array<{ id: string }>)
    : [];
  check('delete all emptied list', wipedList.length === 0);
  const wipeEmpty = await api('DELETE', '/api/saves');
  check(
    'delete all idempotent empty',
    wipeEmpty.status === 200 && wipeEmpty.json.ok === true && wipeEmpty.json.deleted === 0,
  );

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

  // Path traversal must not escape data/saves or data/scenarios (audit).
  // Use a single path-segment id so HTTP routers cannot normalize `../` out of the param.
  const {
    assertSafeDataId,
    deleteSaveFile: deleteSaveFileProbe,
    deleteScenarioFile: deleteScenarioFileProbe,
  } = await import('./store/fileStore.js');
  let safeIdThrew = false;
  try {
    assertSafeDataId('../scenarios/destroyer-sub-demo', 'save id');
  } catch (err) {
    safeIdThrew =
      Boolean(err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 400);
  }
  check('assertSafeDataId rejects traversal', safeIdThrew);
  let storeDeleteThrew = false;
  try {
    await deleteSaveFileProbe('../scenarios/destroyer-sub-demo');
  } catch (err) {
    storeDeleteThrew =
      Boolean(err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 400);
  }
  check('deleteSaveFile rejects traversal', storeDeleteThrew);
  let storeScThrew = false;
  try {
    await deleteScenarioFileProbe('../saves/nope');
  } catch (err) {
    storeScThrew =
      Boolean(err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 400);
  }
  check('deleteScenarioFile rejects traversal', storeScThrew);
  const travId = encodeURIComponent('../scenarios/destroyer-sub-demo');
  const travDelete = await api('DELETE', `/api/saves/${travId}`);
  check('delete save rejects path traversal', travDelete.status === 400);
  const travLoad = await api('POST', `/api/saves/${travId}/load`);
  check('load save rejects path traversal', travLoad.status === 400);
  const travSc = await api('DELETE', `/api/scenarios/${encodeURIComponent('../saves/nope')}`);
  check('delete scenario rejects path traversal', travSc.status === 400);
  // Demo scenario must still exist after traversal probes.
  const demoStill = await api('GET', '/api/scenarios');
  const demoList = Array.isArray(demoStill.json)
    ? (demoStill.json as unknown as Array<{ id: string }>)
    : [];
  check(
    'traversal probes left demo scenario',
    demoList.some((s) => s.id === 'destroyer-sub-demo'),
  );

  // --- Weapons: scenarios + torpedo fire + DC drop + umpire GT tracks ---
  {
    const {
      torpedoDudPctFromAspect,
      torpedoDamageFactorFromAspect,
      torpedoHullHalfBreadthM,
      torpedoHitGateM,
      torpedoLengthIdScale,
      torpedoEffectiveHitGateM,
      resolveTorpedoHit,
      segmentClosestPoint,
      truncateTorpedoAtHit,
      createTorpedoTrack,
      torpedoSpreadHeadings,
      clampTorpedoSpreadDeg,
      torpedoSpreadLateralSeparationM,
      TORPEDO_SPREAD_DEFAULT_DEG,
      torpedoFireHeadingFromSolution,
      checkTorpedoOrderArc,
      isTorpedoFireHeadingInRoomArc,
      torpedoRoomGyroAngleDeg,
      buildTorpedoArcBlock,
      formatTorpedoArcBlockNotice,
      shortestBearingDelta,
      TORPEDO_FORWARD_ARC_HALF_DEG,
      TORPEDO_AFT_ARC_HALF_DEG,
      trueBearingFromRelative,
      relativeBearingDeg,
      recordTorpedoClosestApproach,
      nearestTorpedoApproachOnSegment,
      formatTorpedoMissDistance,
      formatTorpedoMissLogSummary,
      formatTorpedoMissTrackLabel,
      torpedoMissNearestContactName,
      torpedoMissBand,
      RECOGNITION_MANUAL_ENTRIES,
      TORPEDO_DEFAULT_DEPTH_M,
      TORPEDO_HIT_DAMAGE,
      TORPEDO_HIT_AUDIO_MAX_DELAY_SEC,
      TORPEDO_NEAR_MISS_M,
      METERS_PER_NAVAL_YARD,
      METERS_PER_DEG_LAT,
      torpedoHitAudioDelaySec,
      applyHealthDamage,
      applyHealthDamageResult,
      healthDamageApplied,
      presentationHealthFromUnrevealedDamage,
      applyUnitKinematics,
      rollCombatCasualties,
      resolveSubsystems,
      PROPULSION_DAMAGED_SPEED_FACTOR,
      DEPTH_CHARGE_DAMAGE_AMOUNT,
      DESTROYER_DECK_GUN_LOAD,
      FLEET_SUB_DECK_GUN_LOAD,
      DECK_GUN_HIT_DAMAGE,
      DECK_GUN_MAX_RANGE_NM,
      DECK_GUN_RELOAD_TURNS,
      defaultDeckGunLoad,
      canDeckGunFireFromDepth,
      canFireDeckGun,
      resolveDeckGunShot,
      deckGunImpactFromSolution,
      deckGunHitGateM,
      deckGunMissBand,
      RADAR_SURFACE_DEPTH_M,
    } = await import('@war-patrol/shared');
    check('beam aspect dud ~2%', Math.abs(torpedoDudPctFromAspect(90) - 2) < 0.01);
    check('end-on dud ~10%', Math.abs(torpedoDudPctFromAspect(0) - 10) < 0.01);
    check('beam damage factor 1', Math.abs(torpedoDamageFactorFromAspect(90) - 1) < 0.01);
    check(
      'end-on damage factor 0.55',
      Math.abs(torpedoDamageFactorFromAspect(0) - 0.55) < 0.01,
    );
    check('torpedo hit audio max delay 90s', TORPEDO_HIT_AUDIO_MAX_DELAY_SEC === 90);
    // Mid-turn hit on a 180 s turn: scale into 90 s window → 45 s (not 90).
    check(
      'torpedo audio delay scales into 90s window',
      Math.abs(torpedoHitAudioDelaySec(5, 0, 180) - 45) < 0.01,
    );
    // End of turn on 180 s → capped at 90 s.
    check(
      'torpedo audio delay caps at max window',
      Math.abs(torpedoHitAudioDelaySec(9, 1, 180) - 90) < 0.01,
    );
    // Short turns unchanged (no stretch).
    check(
      'torpedo audio delay preserves short turns',
      Math.abs(torpedoHitAudioDelaySec(5, 0, 60) - 30) < 0.01,
    );

    // --- Deck gun magazines + geometry + surface gate ---
    check('DD deck gun load 40', defaultDeckGunLoad({ class: 'Destroyer', type: 'Ship' }) === DESTROYER_DECK_GUN_LOAD);
    check(
      'fleet sub deck gun load 20',
      defaultDeckGunLoad({ class: 'Fleet Submarine', type: 'Submarine' }) === FLEET_SUB_DECK_GUN_LOAD,
    );
    check('deck gun max range 8 nm', DECK_GUN_MAX_RANGE_NM === 8);
    check('deck gun reload 2 turns', DECK_GUN_RELOAD_TURNS === 2);
    check('deck gun hit damage 14', DECK_GUN_HIT_DAMAGE === 14);
    check(
      'sub deck gun ok at surface',
      canDeckGunFireFromDepth({
        type: 'Submarine',
        class: 'Fleet Submarine',
        position: { lat: 0, lon: 0, depth: 0 },
      }),
    );
    check(
      'sub deck gun blocked when submerged',
      !canDeckGunFireFromDepth({
        type: 'Submarine',
        class: 'Fleet Submarine',
        position: { lat: 0, lon: 0, depth: RADAR_SURFACE_DEPTH_M + 1 },
      }),
    );
    check(
      'DD deck gun always depth-ok',
      canDeckGunFireFromDepth({
        type: 'Ship',
        class: 'Destroyer',
        position: { lat: 0, lon: 0, depth: 0 },
      }),
    );
    {
      const beamGate = deckGunHitGateM(115, 12, 90);
      check('deck gun Fletcher beam gate > 50 m', beamGate > 50);
      const stationary = deckGunImpactFromSolution({
        firerPosition: { lat: 34.4, lon: -120.0, depth: 0 },
        aimHeading: 0,
        estimatedCourse: 90,
        estimatedSpeedKn: 0,
        estimatedRangeNm: 1.5,
      });
      check(
        'deck gun stationary fire = aim',
        Math.abs(stationary.fireHeading - 0) < 0.01,
      );
      const firer = {
        id: 'gunner',
        name: 'Gunner',
        type: 'Ship' as const,
        class: 'Destroyer' as const,
        position: { lat: 34.4, lon: -120.0, depth: 0 },
        heading: 90,
        speed: 0,
        condition: 'afloat' as const,
        health: 100,
      };
      const target = {
        id: 'tgt',
        name: 'Target',
        type: 'Ship' as const,
        class: 'Destroyer' as const,
        position: { lat: 34.4 + 1.5 / 60, lon: -120.0, depth: 0 },
        heading: 90,
        speed: 0,
        condition: 'afloat' as const,
        health: 100,
        lengthM: 115,
        beamM: 12,
      };
      const hit = resolveDeckGunShot({
        firer: firer as never,
        fire: {
          aimHeading: 0,
          estimatedCourse: 90,
          estimatedSpeedKn: 0,
          estimatedRangeNm: 1.5,
        },
        contacts: [firer as never, target as never],
        turnLengthSeconds: 180,
        seed: 'deckgun-hit',
      });
      check('deck gun perfect stationary solution hits', hit.outcome === 'hit', `got ${hit.outcome} miss=${hit.missDistanceM}`);
      check('deck gun hit damage applied amount', hit.damage === DECK_GUN_HIT_DAMAGE);
      const submerged = {
        ...target,
        id: 'sub',
        name: 'Sub',
        type: 'Submarine' as const,
        class: 'Fleet Submarine' as const,
        position: { ...target.position, depth: 40 },
      };
      const missSub = resolveDeckGunShot({
        firer: firer as never,
        fire: {
          aimHeading: 0,
          estimatedCourse: 90,
          estimatedSpeedKn: 0,
          estimatedRangeNm: 1.5,
        },
        contacts: [firer as never, submerged as never],
        turnLengthSeconds: 180,
        seed: 'deckgun-sub',
      });
      check(
        'deck gun cannot hit submerged sub',
        missSub.outcome === 'miss' && missSub.damage === 0,
        `got ${missSub.outcome}`,
      );
      check('near miss band at 80 m', deckGunMissBand(80) === 'near');
      check('far miss band above 80 m', deckGunMissBand(81) === 'far');
      check(
        'canFireDeckGun requires ammo',
        !canFireDeckGun({
          class: 'Destroyer',
          type: 'Ship',
          condition: 'afloat',
          position: { lat: 0, lon: 0, depth: 0 },
          deckGunLoad: 0,
          deckGunAwaitingReload: false,
          deckGunReloadTurnsRemaining: 0,
        } as never),
      );
    }

    // Applied HP (not rolled effect) must drive combat-log damage + Damage-tab staging.
    // Five × 22 rolls on a fresh hull only remove 100 HP; last blow is a 12-point finish.
    {
      const baseUnit = {
        id: 'ss-hp',
        name: 'Hull',
        type: 'Submarine' as const,
        class: 'Fleet Submarine' as const,
        condition: 'afloat' as const,
        health: 100,
        position: { lat: 0, lon: 0, depth: 80 },
        speed: 3,
        eot: 'ahead_standard' as const,
        heading: 0,
        orderedCourse: 0,
        orderedDepth: 80,
        subsystems: { propulsion: 'intact' as const, sensors: 'intact' as const },
        orders: {},
        maxSpeed: 21,
        turnRate: 12,
        radarSignature: 'small' as const,
        sensors: [],
        stations: [],
        side: 'red' as const,
        faction: 'Red' as const,
        periscopeRaised: false,
        periscopeExposure: 0,
        plotStampTurns: 0,
        activeSonarEnabled: false,
      };
      const applied: number[] = [];
      let u = { ...baseUnit } as unknown as import('@war-patrol/shared').UnitState;
      for (let i = 0; i < 5; i++) {
        const next = applyHealthDamage(u, DEPTH_CHARGE_DAMAGE_AMOUNT);
        applied.push(healthDamageApplied(u, next));
        u = next;
      }
      check(
        'DC overkill applied sum = 100',
        applied.reduce((a, b) => a + b, 0) === 100,
        `applied=${applied.join(',')}`,
      );
      check('DC overkill last applied is remainder 12', applied[4] === 12);
      check('DC overkill no phantom after sunk', healthDamageApplied(u, applyHealthDamage(u, 22)) === 0);

      const events = applied
        .filter((d) => d > 0)
        .map((damage, i) => ({
          kind: 'depth_charge_damage' as const,
          damage,
          id: `e${i}`,
        }));
      let held = [...events];
      let prev = presentationHealthFromUnrevealedDamage(0, held);
      check('staged overkill HP starts at 100', prev === 100);
      for (const e of events) {
        held = held.filter((h) => h.id !== e.id);
        const nextHp = presentationHealthFromUnrevealedDamage(0, held);
        check(
          `staged reveal ${e.id} drops by logged ${e.damage}`,
          prev - nextHp === e.damage,
          `prev=${prev} next=${nextHp} dmg=${e.damage}`,
        );
        prev = nextHp;
      }
      check('staged overkill ends at 0', prev === 0);
    }
    // Granular casualties: deterministic RNG sequences.
    {
      const subBase = {
        id: 'ss-cas',
        name: 'Gato',
        type: 'Submarine' as const,
        class: 'Fleet Submarine' as const,
        classId: 'gato',
        condition: 'afloat' as const,
        health: 60,
        position: { lat: 0, lon: 0, depth: 50 },
        speed: 6,
        eot: 'ahead_standard' as const,
        heading: 90,
        orderedCourse: 90,
        orderedDepth: 50,
        subsystems: resolveSubsystems({}),
        orders: {},
        maxSpeed: 21,
        turnRate: 12,
        lengthM: 95,
        beamM: 8.3,
        radarSignature: 'small' as const,
        sensors: [
          { kind: 'radar' as const },
          { kind: 'hydrophone' as const },
          { kind: 'lookout' as const },
        ],
        stations: [],
        side: 'red',
        faction: 'Red' as const,
        accessToken: 'x',
        periscopeRaised: true,
        periscopeExposure: 1,
        plotStampTurns: 0,
        activeSonarEnabled: false,
      } as unknown as import('@war-patrol/shared').UnitState;

      // Always-true RNG → every eligible roll fires.
      const always = () => 0;
      const { unit: knocked, effects } = applyHealthDamageResult(subBase, 10, always);
      check('granular hit drops HP', knocked.health === 50);
      check(
        'granular rolls name specific effects',
        effects.length >= 1 &&
          effects.every((e) => typeof e.kind === 'string' && e.kind.length > 0),
        `effects=${effects.map((e) => e.kind).join(',')}`,
      );
      check(
        'legacy sensors:disabled migrates all stations',
        resolveSubsystems({ sensors: 'disabled' }).radar === 'disabled' &&
          resolveSubsystems({ sensors: 'disabled' }).hydrophone === 'disabled' &&
          resolveSubsystems({ sensors: 'disabled' }).lookout === 'disabled',
      );

      // Propulsion damaged (not disabled): force only that outcome via rollCombatCasualties.
      const damagedOnly = rollCombatCasualties(
        { ...subBase, health: 30, subsystems: resolveSubsystems({}) },
        30,
        (() => {
          let i = 0;
          // Sensor rolls: skip (return 0.99); control rolls: skip; propulsion: land in damaged band.
          // Order in rollCombatCasualties: radar, hydro, lookout, steering, dive, propulsion.
          const seq = [0.99, 0.99, 0.99, 0.99, 0.99, 0.4];
          return () => seq[Math.min(i++, seq.length - 1)]!;
        })(),
      );
      check(
        'propulsion can be damaged not disabled',
        damagedOnly.subsystems.propulsion === 'damaged' &&
          damagedOnly.effects.some((e) => e.kind === 'propulsion_damaged'),
        `prop=${damagedOnly.subsystems.propulsion} effects=${damagedOnly.effects.map((e) => e.kind).join(',')}`,
      );

      const damagedUnit = {
        ...subBase,
        subsystems: resolveSubsystems({ propulsion: 'damaged' }),
        speed: 20,
        eot: 'ahead_flank' as const,
        orders: { eot: 'ahead_flank' as const },
      };
      const stepped = applyUnitKinematics(damagedUnit, 180);
      const cap = damagedUnit.maxSpeed * PROPULSION_DAMAGED_SPEED_FACTOR;
      check(
        'damaged propulsion caps speed',
        Math.abs(stepped.speed) <= cap + 0.01,
        `speed=${stepped.speed} cap=${cap}`,
      );

      const stuckRudder = {
        ...subBase,
        subsystems: resolveSubsystems({
          steering: 'stuck',
          rudderStuckHeading: 45,
        }),
        orderedCourse: 45,
        heading: 45,
        orders: { course: 180 },
      };
      const noTurn = applyUnitKinematics(stuckRudder, 180);
      check(
        'rudder stuck ignores helm order',
        Math.abs(noTurn.orderedCourse - 45) < 0.01,
        `crs=${noTurn.orderedCourse}`,
      );

      const stuckDive = {
        ...subBase,
        subsystems: resolveSubsystems({
          divePlanes: 'stuck',
          divePlanesStuckDepth: 50,
        }),
        orderedDepth: 50,
        position: { ...subBase.position, depth: 50 },
        orders: { depth: 90 },
      };
      const noDive = applyUnitKinematics(stuckDive, 180);
      check(
        'dive planes stuck ignores depth order',
        noDive.orderedDepth === 50 && Math.abs(noDive.position.depth - 50) < 0.01,
        `ord=${noDive.orderedDepth} keel=${noDive.position.depth}`,
      );

      const radarOnlyOut = resolveSubsystems({ radar: 'disabled' });
      check(
        'radar out leaves hydrophone intact',
        radarOnlyOut.radar === 'disabled' && radarOnlyOut.hydrophone === 'intact',
      );
    }
    // Fletcher 115×12: beam aspect gate ≈ length/2 + pad; end-on ≈ beam/2 + pad.
    const beamGate = torpedoHitGateM(115, 12, 90);
    const endGate = torpedoHitGateM(115, 12, 0);
    check('beam gate ~ length/2', beamGate > 50 && beamGate < 70);
    check('end-on gate ~ beam/2', endGate > 5 && endGate < 12);
    check(
      'half breadth beam = length/2',
      Math.abs(torpedoHullHalfBreadthM(115, 12, 90) - 57.5) < 0.01,
    );
    // Length ID: recognition-manual accuracy scales the true geometric gate.
    // Museum / forgiveness tuning: ±25% full / ≥75% zero (was ±15% / ≥50%); pad 5 m unchanged.
    check('length ID exact = 1', torpedoLengthIdScale(115, 115) === 1);
    check('length ID ±25% full', torpedoLengthIdScale(143, 115) === 1);
    check(
      'length ID just over 25% partial',
      torpedoLengthIdScale(145, 115) > 0 && torpedoLengthIdScale(145, 115) < 1,
    );
    check('length ID zero when blank', torpedoLengthIdScale(0, 115) === 0);
    check(
      'length ID battleship-for-DD collapses',
      torpedoLengthIdScale(270, 115) === 0,
    );
    check(
      'length ID mid error partial',
      torpedoLengthIdScale(150, 115) > 0 && torpedoLengthIdScale(150, 115) < 1,
    );
    // Quantify ease: Fletcher beam gate + pad, and mid-error scale vs old bands.
    check(
      'ease pad → Fletcher beam gate 62.5 m',
      Math.abs(beamGate - 62.5) < 0.01,
    );
    check(
      'ease pad → Fletcher end-on gate 11 m',
      Math.abs(endGate - 11) < 0.01,
    );
    {
      // 150 vs 115 ≈ 30.4% rel err → scale 1 − (0.304−0.25)/(0.75−0.25) ≈ 0.891
      const midScale = torpedoLengthIdScale(150, 115);
      check(
        'museum-tuning length mid-error ~0.89 (was ~0.56)',
        midScale > 0.88 && midScale < 0.9,
        `scale=${midScale}`,
      );
    }
    check(
      'effective gate = true × scale',
      Math.abs(
        torpedoEffectiveHitGateM(115, 12, 90, 115) - beamGate,
      ) < 1e-9,
    );
    check(
      'wrong length shrinks gate',
      torpedoEffectiveHitGateM(115, 12, 90, 270) === 0,
    );
    check(
      'recognition manual has Fletcher 115',
      RECOGNITION_MANUAL_ENTRIES.some((e) => e.class === 'Destroyer' && e.lengthM === 115),
    );
    check(
      'recognition manual has Kagerō 119×11',
      RECOGNITION_MANUAL_ENTRIES.some(
        (e) => e.class === 'Destroyer' && e.lengthM === 119 && e.beamM === 11,
      ),
    );
    check(
      'recognition manual has Cimarron 169×23',
      RECOGNITION_MANUAL_ENTRIES.some(
        (e) => e.class === 'Oiler' && e.lengthM === 169 && e.beamM === 23,
      ),
    );
    check(
      'recognition manual has Shōkaku 258×26',
      RECOGNITION_MANUAL_ENTRIES.some(
        (e) =>
          e.class === 'Aircraft Carrier' &&
          e.lengthM === 258 &&
          e.beamM === 26 &&
          e.name.includes('Shōkaku'),
      ),
    );
    check(
      'recognition manual keeps Essex 266×28',
      RECOGNITION_MANUAL_ENTRIES.some(
        (e) =>
          e.class === 'Aircraft Carrier' &&
          e.lengthM === 266 &&
          e.beamM === 28 &&
          e.name.includes('Essex'),
      ),
    );
    // Default 1.5° fan: odd count puts one fish on the center axis.
    const fan = torpedoSpreadHeadings(0, 3, TORPEDO_SPREAD_DEFAULT_DEG).map(
      (h) => Math.round(h * 10) / 10,
    );
    check(
      'spread 3×default headings',
      fan[0] === 358.5 && fan[1] === 0 && fan[2] === 1.5,
      `got ${fan.join(',')}`,
    );
    // Even counts straddle the center axis (no fish on fire heading).
    const evenFan = torpedoSpreadHeadings(90, 2, 2).map((h) => Math.round(h * 10) / 10);
    check(
      'spread 2×2° straddles center',
      evenFan[0] === 89 && evenFan[1] === 91,
      `got ${evenFan.join(',')}`,
    );

    // Museum-range lateral separation: adjacent tips after running R nm should
    // be ≈ R·1852·tan(δ). Old 0.1° min was only ~3 m at 1 nm (tracks stacked).
    // Default 1.5° keeps multi-hit on one hull (Wade) while staying visible.
    {
      const { moveAlongHeading, eastNorthMeters, METERS_PER_NM } = await import(
        '@war-patrol/shared'
      );
      const origin = { lat: 0, lon: 0, depth: 0 };
      const rangeNm = 1;
      const spacing = TORPEDO_SPREAD_DEFAULT_DEG;
      const expectedM = torpedoSpreadLateralSeparationM(rangeNm, spacing);
      check(
        'default spread lateral at 1 nm ≈ 48 m',
        expectedM > 45 && expectedM < 52,
        `got ${expectedM.toFixed(1)} m`,
      );
      // Tiny legacy-scale fans must stay well below the museum min.
      const microscopic = rangeNm * METERS_PER_NM * Math.tan((0.1 * Math.PI) / 180);
      check(
        'legacy 0.1° fan at 1 nm is negligible (~3 m)',
        microscopic < 4,
        `got ${microscopic.toFixed(1)} m`,
      );
      check(
        'museum min lateral at 1 nm ≥ ~30 m',
        torpedoSpreadLateralSeparationM(rangeNm, TORPEDO_SPREAD_MIN_DEG) >= 30,
      );

      const headings = torpedoSpreadHeadings(0, 3, spacing);
      const tips = headings.map((h) =>
        moveAlongHeading(origin, h, rangeNm * METERS_PER_NM),
      );
      const left = eastNorthMeters(tips[1]!, tips[0]!);
      const right = eastNorthMeters(tips[1]!, tips[2]!);
      const leftSep = Math.hypot(left.east, left.north);
      const rightSep = Math.hypot(right.east, right.north);
      check(
        '3-fish tip separation matches tan model (left)',
        Math.abs(leftSep - expectedM) < 1,
        `got ${leftSep.toFixed(1)} want ${expectedM.toFixed(1)}`,
      );
      check(
        '3-fish tip separation matches tan model (right)',
        Math.abs(rightSep - expectedM) < 1,
        `got ${rightSep.toFixed(1)} want ${expectedM.toFixed(1)}`,
      );

      // Multi-hit geometry (Wade): default fan at 1 nm puts outer fish inside
      // a Fletcher beam gate (~62.5 m); a wide 4° fan does not.
      const fletcherBeamGate = torpedoEffectiveHitGateM(115, 12, 90, 115);
      check(
        'default outer CPA inside Fletcher beam gate (multi-hit)',
        expectedM <= fletcherBeamGate,
        `sep=${expectedM.toFixed(1)} gate=${fletcherBeamGate.toFixed(1)}`,
      );
      const centerRoll = resolveTorpedoHit({
        missDistanceM: 0,
        fishHeading: 0,
        targetHeading: 90,
        trueLengthM: 115,
        trueBeamM: 12,
        estimatedLengthM: 115,
        depthOk: true,
        seed: 'spread-center',
      });
      const outerDefaultRoll = resolveTorpedoHit({
        missDistanceM: expectedM,
        fishHeading: headings[0]!,
        targetHeading: 90,
        trueLengthM: 115,
        trueBeamM: 12,
        estimatedLengthM: 115,
        depthOk: true,
        seed: 'spread-outer-default',
      });
      check(
        'spread center fish geometric contact',
        !centerRoll.geometricMiss,
        `geoMiss=${centerRoll.geometricMiss} hit=${centerRoll.hit} dud=${centerRoll.dud}`,
      );
      check(
        'spread outer fish geometric contact at default (multi-hit)',
        !outerDefaultRoll.geometricMiss,
        `geoMiss=${outerDefaultRoll.geometricMiss} gate=${outerDefaultRoll.hitGateM}`,
      );

      const wideSep = torpedoSpreadLateralSeparationM(rangeNm, 4);
      const outerWideRoll = resolveTorpedoHit({
        missDistanceM: wideSep,
        fishHeading: -4,
        targetHeading: 90,
        trueLengthM: 115,
        trueBeamM: 12,
        estimatedLengthM: 115,
        depthOk: true,
        seed: 'spread-outer-wide',
      });
      check(
        'wide 4° outer fish geometric miss on Fletcher',
        outerWideRoll.geometricMiss,
        `sep=${wideSep.toFixed(1)} gate=${outerWideRoll.hitGateM}`,
      );

      // At 1.5 nm museum drill range, default still multi-hits a Cimarron
      // (~90 m gate) even though Fletcher goes center-only.
      const oilerSep15 = torpedoSpreadLateralSeparationM(1.5, spacing);
      const oilerGate = torpedoEffectiveHitGateM(169, 23, 90, 169);
      const oilerOuter = resolveTorpedoHit({
        missDistanceM: oilerSep15,
        fishHeading: -spacing,
        targetHeading: 90,
        trueLengthM: 169,
        trueBeamM: 23,
        estimatedLengthM: 169,
        depthOk: true,
        seed: 'spread-oiler-15',
      });
      check(
        'default outer at 1.5 nm still hits Cimarron (multi-hit large hull)',
        oilerSep15 <= oilerGate && !oilerOuter.geometricMiss,
        `sep=${oilerSep15.toFixed(1)} gate=${oilerGate.toFixed(1)}`,
      );
      check(
        'default outer at 1.5 nm misses Fletcher (DD gate tighter)',
        torpedoSpreadLateralSeparationM(1.5, spacing) >
          torpedoEffectiveHitGateM(115, 12, 90, 115),
      );
    }

    // Spread interval control step is 0.5° (museum dial — was 0.1°, before
    // that whole degrees / ~5° jumps); clamp normalizes to that grid and the
    // min–max bounds. Min is ≥ 1° so microscopic fans cannot stack tracks.
    check('spread interval snaps to 0.5° grid', clampTorpedoSpreadDeg(3.6) === 3.5);
    check('spread interval rounds to nearest 0.5° step', clampTorpedoSpreadDeg(3.2) === 3);
    check(
      'spread interval negative falls back to default',
      clampTorpedoSpreadDeg(-1) === TORPEDO_SPREAD_DEFAULT_DEG,
    );
    check('spread interval clamps to max', clampTorpedoSpreadDeg(50) === TORPEDO_SPREAD_MAX_DEG);
    check(
      'spread interval of 0 clamps up to min (never 0°)',
      clampTorpedoSpreadDeg(0) === TORPEDO_SPREAD_MIN_DEG && TORPEDO_SPREAD_MIN_DEG >= 1,
    );
    check(
      'spread below min snaps up to min',
      clampTorpedoSpreadDeg(0.5) === TORPEDO_SPREAD_MIN_DEG,
    );

    // Umpire miss-distance helpers (CPA format + near/far band + track accumulate).
    check('near miss band at 100 m', torpedoMissBand(TORPEDO_NEAR_MISS_M) === 'near');
    check('far miss band above 100 m', torpedoMissBand(TORPEDO_NEAR_MISS_M + 1) === 'far');
    check(
      'miss distance formats m + yd',
      formatTorpedoMissDistance(92.6) === `93 m (${Math.round(92.6 / METERS_PER_NAVAL_YARD)} yd)`,
    );
    check(
      'miss log with CPA names target',
      formatTorpedoMissLogSummary({
        firerName: 'Gato',
        targetName: 'Porter',
        closestApproachM: 42,
      }).includes('MISSED Porter') &&
        formatTorpedoMissLogSummary({
          firerName: 'Gato',
          targetName: 'Porter',
          closestApproachM: 42,
        }).includes('near miss'),
    );
    check(
      'miss log without CPA is exhaust fallback',
      formatTorpedoMissLogSummary({ firerName: 'Gato' }).includes('exhausted run'),
    );
    check(
      'GT miss label names nearest contact',
      formatTorpedoMissTrackLabel({
        closestApproachM: 200,
        targetName: 'USS Platte',
      }) === 'FISH · MISS USS Platte 200m (FAR)',
    );
    check(
      'GT miss label near band',
      formatTorpedoMissTrackLabel({ closestApproachM: 80, targetName: 'Porter' }).includes('(NEAR)'),
    );
    check(
      'GT miss label without CPA stays exhausted',
      formatTorpedoMissTrackLabel({}) === 'FISH · EXHAUSTED',
    );
    {
      const fish0 = createTorpedoTrack({
        id: 'cpa-test',
        firerUnitId: 'ss-212',
        position: { lat: 0, lon: 0, depth: 3 },
        heading: 0,
        runDepthM: TORPEDO_DEFAULT_DEPTH_M,
        launchedTurn: 1,
        estimatedCourse: 90,
        estimatedSpeedKn: 0,
        estimatedRangeNm: 1,
        estimatedLengthM: 115,
      });
      const closer = recordTorpedoClosestApproach(fish0, 80, 'dd-101', 'Porter');
      const farther = recordTorpedoClosestApproach(closer, 120, 'dd-other', 'Farragut');
      const nearer = recordTorpedoClosestApproach(farther, 40, 'dd-near', 'Maury');
      check('CPA keeps closer approach', closer.closestApproachM === 80);
      check('CPA ignores farther approach', farther.closestApproachM === 80);
      check(
        'CPA updates to nearer target',
        nearer.closestApproachM === 40 &&
          nearer.closestApproachUnitId === 'dd-near' &&
          nearer.closestApproachUnitName === 'Maury',
      );
      check(
        'CPA name prefers snapshotted nearest',
        torpedoMissNearestContactName(nearer) === 'Maury',
      );
    }
    {
      // Platte @ ~200 m north of track; Neosho ~6000 m east — nearest must be Platte.
      const from = { lat: 34.4, lon: -120.0, depth: 3 };
      const to = { lat: 34.4 + 2000 / METERS_PER_DEG_LAT, lon: -120.0, depth: 3 };
      const platte = {
        id: 'ao-24',
        name: 'USS Platte',
        type: 'Ship' as const,
        class: 'Oiler',
        side: 'blue' as const,
        faction: 'Blue' as const,
        position: { lat: 34.4, lon: -120.0 + 200 / (METERS_PER_DEG_LAT * Math.cos((34.4 * Math.PI) / 180)), depth: 0 },
        heading: 90,
        speed: 12,
        eot: 'ahead_standard' as const,
        health: 100,
        maxSpeed: 18,
        condition: 'afloat' as const,
        subsystems: { propulsion: 'intact' as const, sensors: 'intact' as const },
      };
      const neosho = {
        ...platte,
        id: 'ao-23',
        name: 'USS Neosho',
        position: {
          lat: 34.4,
          lon: -120.0 + 6000 / (METERS_PER_DEG_LAT * Math.cos((34.4 * Math.PI) / 180)),
          depth: 0,
        },
      };
      const nearest = nearestTorpedoApproachOnSegment(
        from,
        to,
        [neosho, platte] as unknown as import('@war-patrol/shared').UnitState[],
        'ss-212',
      );
      check(
        'nearest CPA picks Platte over Neosho',
        !!nearest &&
          nearest.unitId === 'ao-24' &&
          nearest.unitName === 'USS Platte' &&
          nearest.missM < 250 &&
          nearest.missM > 150,
        nearest
          ? `id=${nearest.unitId} miss=${nearest.missM.toFixed(1)}`
          : 'no nearest',
      );
      const fishNear = recordTorpedoClosestApproach(
        createTorpedoTrack({
          id: 'cpa-platte',
          firerUnitId: 'ss-212',
          position: from,
          heading: 0,
          runDepthM: TORPEDO_DEFAULT_DEPTH_M,
          launchedTurn: 1,
          estimatedCourse: 90,
          estimatedSpeedKn: 0,
          estimatedRangeNm: 1.5,
          estimatedLengthM: 169,
        }),
        nearest!.missM,
        nearest!.unitId,
        nearest!.unitName,
      );
      const afterFar = recordTorpedoClosestApproach(fishNear, 6000, 'ao-23', 'USS Neosho');
      check(
        'accumulated CPA stays on Platte not Neosho',
        afterFar.closestApproachUnitId === 'ao-24' &&
          afterFar.closestApproachUnitName === 'USS Platte' &&
          (afterFar.closestApproachM ?? 9999) < 250,
      );
      check(
        'miss log names Platte not Neosho',
        formatTorpedoMissLogSummary({
          firerName: 'Gato',
          targetName: afterFar.closestApproachUnitName,
          closestApproachM: afterFar.closestApproachM,
        }).includes('MISSED USS Platte') &&
          !formatTorpedoMissLogSummary({
            firerName: 'Gato',
            targetName: afterFar.closestApproachUnitName,
            closestApproachM: afterFar.closestApproachM,
          }).includes('Neosho'),
      );
    }

    // Solution-driven intercept: estimates (not truth) set the fire heading.
    const stationarySol = torpedoFireHeadingFromSolution({
      aimHeading: 0,
      estimatedCourse: 90,
      estimatedSpeedKn: 0,
      estimatedRangeNm: 1.5,
    });
    check(
      'stationary solution fire = aim',
      Math.abs(stationarySol.fireHeading - 0) < 0.01 && stationarySol.solvable,
    );
    const beamSol = torpedoFireHeadingFromSolution({
      aimHeading: 0,
      estimatedCourse: 90,
      estimatedSpeedKn: 14,
      estimatedRangeNm: 1.5,
    });
    check(
      'beam solution lead ~18°',
      beamSol.solvable && beamSol.fireHeading > 16 && beamSol.fireHeading < 20,
      `fire=${beamSol.fireHeading}`,
    );
    check(
      'forward arc half-angle 45°',
      TORPEDO_FORWARD_ARC_HALF_DEG === 45 && TORPEDO_AFT_ARC_HALF_DEG === 45,
    );
    check(
      'forward dead-ahead in arc',
      isTorpedoFireHeadingInRoomArc(0, 0, 'forward'),
    );
    check(
      'forward +45° on edge in arc',
      isTorpedoFireHeadingInRoomArc(0, 45, 'forward'),
    );
    check(
      'forward +46° outside arc',
      !isTorpedoFireHeadingInRoomArc(0, 46, 'forward'),
    );
    check(
      'aft dead-astern in arc',
      isTorpedoFireHeadingInRoomArc(0, 180, 'aft'),
    );
    check(
      'aft ahead shot outside arc',
      !isTorpedoFireHeadingInRoomArc(0, 0, 'aft'),
    );
    check(
      'aft tube gyro 0 at stern',
      Math.abs(torpedoRoomGyroAngleDeg(90, 270, 'aft')) < 0.01,
    );
    {
      const aftOk = checkTorpedoOrderArc({
        ownHeadingDeg: 0,
        room: 'aft',
        aimHeading: 180,
        estimatedCourse: 90,
        estimatedSpeedKn: 0,
        estimatedRangeNm: 1,
        spreadCount: 1,
      });
      check('aft stationary aim astern in arc', aftOk.ok && Math.abs(aftOk.gyroDeg) < 0.01);
      const fwdBeam = checkTorpedoOrderArc({
        ownHeadingDeg: 0,
        room: 'forward',
        aimHeading: 0,
        estimatedCourse: 90,
        estimatedSpeedKn: 14,
        estimatedRangeNm: 1.5,
        spreadCount: 3,
        spreadDeg: 2,
      });
      check('forward beam solution fan in arc', fwdBeam.ok);
      const aftBad = checkTorpedoOrderArc({
        ownHeadingDeg: 0,
        room: 'aft',
        aimHeading: 0,
        estimatedCourse: 90,
        estimatedSpeedKn: 0,
        estimatedRangeNm: 1,
      });
      check('aft aim ahead rejected by arc check', !aftBad.ok);
      const notice = formatTorpedoArcBlockNotice(buildTorpedoArcBlock(aftBad, 7, 90));
      check(
        'blocked-salvo notice names turn, arc, and unspent fish',
        notice.includes('Turn 7') &&
          notice.includes('Aft') &&
          notice.includes('±45°') &&
          notice.includes('No fish expended'),
        notice,
      );
    }
    // Optics-style relative aim → true: port contact must not fire starboard.
    const ownHdg0 = 0;
    const portRel = -90;
    const portTrue = trueBearingFromRelative(ownHdg0, portRel);
    check('port 90° rel → true 270', Math.abs(portTrue - 270) < 0.01);
    check(
      'port true round-trips to rel',
      Math.abs(relativeBearingDeg(ownHdg0, portTrue) - portRel) < 0.01,
    );
    const portSol = torpedoFireHeadingFromSolution({
      aimHeading: portTrue,
      estimatedCourse: 0,
      estimatedSpeedKn: 0,
      estimatedRangeNm: 1.5,
    });
    check(
      'port-beam stationary fish run west (not east)',
      Math.abs(portSol.fireHeading - 270) < 0.01,
      `fire=${portSol.fireHeading}`,
    );
    // Mistakenly treating optics "090° port" number as true 090 fires opposite.
    const mistakenEast = torpedoFireHeadingFromSolution({
      aimHeading: 90,
      estimatedCourse: 0,
      estimatedSpeedKn: 0,
      estimatedRangeNm: 1.5,
    });
    check(
      'true-090 is opposite of port-beam solution',
      Math.abs(
        Math.abs(
          ((mistakenEast.fireHeading - portSol.fireHeading + 540) % 360) - 180,
        ) - 180,
      ) < 0.01,
      `mistaken=${mistakenEast.fireHeading} port=${portSol.fireHeading}`,
    );
    const ownHdg180 = 180;
    const aheadTrue = trueBearingFromRelative(ownHdg180, 0);
    check('dead-ahead rel0 @ HDG180 → true 180', Math.abs(aheadTrue - 180) < 0.01);
    const aheadSol = torpedoFireHeadingFromSolution({
      aimHeading: aheadTrue,
      estimatedCourse: 90,
      estimatedSpeedKn: 0,
      estimatedRangeNm: 1.5,
    });
    check(
      'dead-ahead fish run south with own HDG 180',
      Math.abs(aheadSol.fireHeading - 180) < 0.01,
      `fire=${aheadSol.fireHeading}`,
    );
    const roll = resolveTorpedoHit({
      missDistanceM: 5,
      fishHeading: 0,
      targetHeading: 90,
      trueLengthM: 115,
      trueBeamM: 12,
      estimatedLengthM: 115,
      depthOk: true,
      seed: 'verify-aspect-beam-geo',
    });
    check('beam geometric contact', roll.geometricMiss === false);
    check('beam gate applied', roll.hitGateM === beamGate);
    check('beam length ID full', roll.lengthIdScale === 1);
    check(
      'beam hit or dud',
      (roll.hit && !roll.dud && roll.damage === TORPEDO_HIT_DAMAGE) ||
        (!roll.hit && roll.dud && roll.damage === 0),
    );
    const missRoll = resolveTorpedoHit({
      missDistanceM: 200,
      fishHeading: 0,
      targetHeading: 90,
      trueLengthM: 115,
      trueBeamM: 12,
      estimatedLengthM: 115,
      depthOk: true,
      seed: 'verify-geo-miss',
    });
    check('far miss is geometric', missRoll.geometricMiss === true);
    check('far miss no hit', missRoll.hit === false);
    const wrongLenRoll = resolveTorpedoHit({
      missDistanceM: 5,
      fishHeading: 0,
      targetHeading: 90,
      trueLengthM: 115,
      trueBeamM: 12,
      estimatedLengthM: 270,
      depthOk: true,
      seed: 'verify-wrong-length',
    });
    check('wrong length ID geometric miss', wrongLenRoll.geometricMiss === true);
    check('wrong length ID no hit', wrongLenRoll.hit === false);
    check('wrong length ID scale 0', wrongLenRoll.lengthIdScale === 0);

    // Hit path truncation: trail ends at closest approach, not past the target.
    {
      const before = { lat: 0, lon: 0, depth: TORPEDO_DEFAULT_DEPTH_M };
      const after = { lat: 0.02, lon: 0, depth: TORPEDO_DEFAULT_DEPTH_M };
      const target = { lat: 0.01, lon: 0.0001 };
      const closest = segmentClosestPoint(before, after, target);
      check('closest point mid-segment', closest.t > 0.4 && closest.t < 0.6);
      const prior = createTorpedoTrack({
        id: 't-trunc',
        firerUnitId: 'sub',
        position: before,
        heading: 0,
        runDepthM: TORPEDO_DEFAULT_DEPTH_M,
        launchedTurn: 1,
        estimatedCourse: 90,
        estimatedSpeedKn: 14,
        estimatedRangeNm: 1.5,
        estimatedLengthM: 115,
      });
      const advanced = {
        ...prior,
        position: after,
        path: [
          { lat: before.lat, lon: before.lon },
          { lat: after.lat, lon: after.lon },
        ],
        remainingRunNm: 4,
      };
      const hit = truncateTorpedoAtHit(prior, advanced, before, closest, 'dd-1');
      const tip = hit.path[hit.path.length - 1]!;
      check('hit status set', hit.status === 'hit');
      check(
        'hit tip equals position',
        Math.abs(tip.lat - hit.position.lat) < 1e-9 && Math.abs(tip.lon - hit.position.lon) < 1e-9,
      );
      check(
        'hit tip not past target',
        Math.abs(tip.lat - closest.lat) < 1e-9 && Math.abs(tip.lon - closest.lon) < 1e-9,
      );
      check('hit tip before segment end', tip.lat < after.lat - 1e-6);
    }

    const scAll = await api('GET', '/api/scenarios');
    const scArr = Array.isArray(scAll.json)
      ? (scAll.json as unknown as Array<{ id: string; name: string }>)
      : [];
    check(
      'depth-charge-audio-test scenario listed',
      scArr.some((s) => s.id === 'depth-charge-audio-test'),
    );
    check(
      'torpedo-fire-test scenario listed',
      scArr.some((s) => s.id === 'torpedo-fire-test'),
    );
    check(
      'cimarron-convoy-torpedo-test scenario listed',
      scArr.some((s) => s.id === 'cimarron-convoy-torpedo-test'),
    );
    check(
      'shokaku-carrier-lookout-test scenario listed',
      scArr.some((s) => s.id === 'shokaku-carrier-lookout-test'),
    );
    check(
      'kagero-destroyer-lookout-test scenario listed',
      scArr.some((s) => s.id === 'kagero-destroyer-lookout-test'),
    );
    check(
      'cavalla-shokaku-philippine-sea scenario listed',
      scArr.some((s) => s.id === 'cavalla-shokaku-philippine-sea'),
    );
    check(
      'deep-dc-test scenario listed',
      scArr.some((s) => s.id === 'deep-dc-test'),
    );

    {
      const lib = await api('GET', '/api/library');
      check('library list ok', lib.status === 200);
      const libRaw = lib.json as unknown;
      const libArr = Array.isArray(libRaw)
        ? (libRaw as Array<{
            id: string;
            class?: string;
            maxSpeed?: number;
            lengthM?: number;
            beamM?: number;
            turnRate?: number;
            defaultFaction?: string;
          }>)
        : [];
      const shokaku = libArr.find((c) => c.id === 'shokaku-class');
      check('library has shokaku-class', Boolean(shokaku), `count=${libArr.length}`);
      check(
        'shokaku-class is Aircraft Carrier NPC hull',
        Boolean(
          shokaku &&
            shokaku.class === 'Aircraft Carrier' &&
            shokaku.maxSpeed === 34 &&
            shokaku.lengthM === 258 &&
            shokaku.beamM === 26 &&
            shokaku.turnRate === 4 &&
            shokaku.defaultFaction === 'Red',
        ),
      );
      const kagero = libArr.find((c) => c.id === 'kagero-class');
      check('library has kagero-class', Boolean(kagero), `count=${libArr.length}`);
      check(
        'kagero-class is Destroyer playable IJN hull',
        Boolean(
          kagero &&
            kagero.class === 'Destroyer' &&
            kagero.maxSpeed === 35 &&
            kagero.lengthM === 119 &&
            kagero.beamM === 11 &&
            kagero.turnRate === 7 &&
            kagero.defaultFaction === 'Red',
        ),
      );
      const zeke = libArr.find((c) => c.id === 'zeke-fighter');
      check('library has zeke-fighter', Boolean(zeke), `count=${libArr.length}`);
      check(
        'zeke-fighter is IJN Fighter NPC airframe',
        Boolean(
          zeke &&
            zeke.class === 'Fighter' &&
            zeke.maxSpeed === 305 &&
            zeke.lengthM === 9 &&
            zeke.beamM === 12 &&
            zeke.turnRate === 12 &&
            zeke.defaultFaction === 'Red',
        ),
      );
      const hellcat = libArr.find((c) => c.id === 'hellcat-fighter');
      check('library has hellcat-fighter', Boolean(hellcat), `count=${libArr.length}`);
      check(
        'hellcat-fighter is Fighter NPC airframe',
        Boolean(
          hellcat &&
            hellcat.class === 'Fighter' &&
            hellcat.maxSpeed === 320 &&
            hellcat.turnRate === 12,
        ),
      );
    }

    {
      const cvGame = await api('POST', '/api/games', {
        scenarioId: 'shokaku-carrier-lookout-test',
        name: 'Verify Shōkaku Carrier',
      });
      check('shokaku carrier scenario create', cvGame.status === 200);
      const cvId = String(cvGame.json.gameId);
      const cvUmp = await api('POST', `/api/games/${cvId}/auth/umpire`, {
        password: 'umpire',
      });
      const cvUTok = String(cvUmp.json.token);
      const cvView = await api('GET', `/api/games/${cvId}/view`, undefined, cvUTok);
      const cvUmpireView = cvView.json.view as {
        units?: Array<{
          id: string;
          class?: string;
          classId?: string;
          faction?: string;
          lengthM?: number;
          beamM?: number;
          maxSpeed?: number;
          turnRate?: number;
          radarSignature?: string;
          accessToken?: string;
        }>;
        vesselLinks?: Array<{
          unitId: string;
          playerVessel?: boolean;
          stations?: unknown[];
          accessToken?: string;
        }>;
      };
      const cvUnits = cvUmpireView.units ?? [];
      const carrier = cvUnits.find((u) => u.id === 'cv-shokaku');
      check('shokaku unit present', Boolean(carrier));
      check(
        'shokaku seeded 258×26 / 34 kn / large / turnRate 4',
        carrier?.class === 'Aircraft Carrier' &&
          carrier.classId === 'shokaku-class' &&
          carrier.faction === 'Red' &&
          carrier.lengthM === 258 &&
          carrier.beamM === 26 &&
          carrier.maxSpeed === 34 &&
          carrier.turnRate === 4 &&
          carrier.radarSignature === 'large',
      );
      check(
        'shokaku has no vessel accessToken (NPC)',
        !carrier?.accessToken,
      );
      {
        const cvSave = runtime.requireGame(cvId);
        const cvUnit = cvSave.units.find((u) => u.id === 'cv-shokaku')!;
        check(
          'shokaku not a v1 player unit',
          !isV1PlayerHullClass(cvUnit.class) && cvUnit.class === 'Aircraft Carrier',
        );
        check(
          'shokaku turnRate capital carrier (not destroyer)',
          cvUnit.turnRate === 4 && cvUnit.turnRate < defaultTurnRateForClass('Destroyer'),
        );
      }
      const links = cvUmpireView.vesselLinks ?? [];
      const cvLink = links.find((l) => l.unitId === 'cv-shokaku');
      const gatoLink = links.find((l) => l.unitId === 'ss-212');
      check(
        'shokaku vessel link is non-player (no station joins)',
        cvLink?.playerVessel === false &&
          Array.isArray(cvLink.stations) &&
          cvLink.stations.length === 0,
      );
      check(
        'gato remains playable in shokaku scenario',
        gatoLink?.playerVessel === true &&
          Array.isArray(gatoLink.stations) &&
          (gatoLink.stations as unknown[]).length === 2,
      );

      // Raise mast so periscope paints the carrier silhouette class.
      await api(
        'PATCH',
        `/api/games/${cvId}/units/ss-212`,
        { position: { lat: 34.37504, lon: -120.0, depth: 18 } },
        cvUTok,
      );
      const gatoAuth = await api('POST', `/api/games/${cvId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'sensors',
      });
      check('shokaku scenario gato sensors auth', gatoAuth.status === 200);
      const gatoTok = String(gatoAuth.json.token);
      const raiseCvPeri = await api(
        'POST',
        `/api/games/${cvId}/periscope`,
        { raised: true },
        gatoTok,
      );
      check('shokaku scenario raise periscope', raiseCvPeri.status === 200);
      const periView = await api('GET', `/api/games/${cvId}/view`, undefined, gatoTok);
      const periContacts = (periView.json.view as { periscopeContacts?: Array<Json> })
        .periscopeContacts;
      check(
        'shokaku peri paints carrier silhouette class',
        Array.isArray(periContacts) &&
          periContacts.some((c) => c.silhouetteClass === 'Aircraft Carrier'),
      );
    }

    {
      const kgGame = await api('POST', '/api/games', {
        scenarioId: 'kagero-destroyer-lookout-test',
        name: 'Verify Kagerō Destroyer',
      });
      check('kagero destroyer scenario create', kgGame.status === 200);
      const kgId = String(kgGame.json.gameId);
      const kgUmp = await api('POST', `/api/games/${kgId}/auth/umpire`, {
        password: 'umpire',
      });
      const kgUTok = String(kgUmp.json.token);
      const kgView = await api('GET', `/api/games/${kgId}/view`, undefined, kgUTok);
      const kgUmpireView = kgView.json.view as {
        units?: Array<{
          id: string;
          class?: string;
          classId?: string;
          faction?: string;
          lengthM?: number;
          beamM?: number;
          maxSpeed?: number;
          turnRate?: number;
          radarSignature?: string;
          accessToken?: string;
        }>;
        vesselLinks?: Array<{
          unitId: string;
          playerVessel?: boolean;
          stations?: unknown[];
          accessToken?: string;
        }>;
      };
      const kgUnits = kgUmpireView.units ?? [];
      const dd = kgUnits.find((u) => u.id === 'dd-kagero');
      check('kagero unit present', Boolean(dd));
      check(
        'kagero seeded 119×11 / 35 kn / medium / turnRate 7',
        dd?.class === 'Destroyer' &&
          dd.classId === 'kagero-class' &&
          dd.faction === 'Red' &&
          dd.lengthM === 119 &&
          dd.beamM === 11 &&
          dd.maxSpeed === 35 &&
          dd.turnRate === 7 &&
          dd.radarSignature === 'medium',
      );
      check('kagero has vessel accessToken (playable)', Boolean(dd?.accessToken));
      {
        const kgSave = runtime.requireGame(kgId);
        const kgUnit = kgSave.units.find((u) => u.id === 'dd-kagero')!;
        check(
          'kagero is a v1 player Destroyer unit',
          isV1PlayerHullClass(kgUnit.class) &&
            isV1PlayerUnit(kgUnit) &&
            kgUnit.class === 'Destroyer',
        );
        check(
          'kagero turnRate destroyer band (7°/min)',
          kgUnit.turnRate === 7 &&
            kgUnit.turnRate === defaultTurnRateForClass('Destroyer'),
        );
      }
      const kgLinks = kgUmpireView.vesselLinks ?? [];
      const kgLink = kgLinks.find((l) => l.unitId === 'dd-kagero');
      const kgGatoLink = kgLinks.find((l) => l.unitId === 'ss-212');
      check(
        'kagero vessel link is playable (Controls + Sensors joins)',
        kgLink?.playerVessel === true &&
          Array.isArray(kgLink.stations) &&
          (kgLink.stations as unknown[]).length === 2,
      );
      check(
        'gato remains playable in kagero scenario',
        kgGatoLink?.playerVessel === true &&
          Array.isArray(kgGatoLink.stations) &&
          (kgGatoLink.stations as unknown[]).length === 2,
      );

      const kgDdAuth = await api('POST', `/api/games/${kgId}/auth/vessel`, {
        accessToken: 'kagero-demo',
        password: 'red',
        stationId: 'controls',
      });
      check('kagero controls station auth', kgDdAuth.status === 200);

      await api(
        'PATCH',
        `/api/games/${kgId}/units/ss-212`,
        { position: { lat: 34.37504, lon: -120.0, depth: 18 } },
        kgUTok,
      );
      const kgGatoAuth = await api('POST', `/api/games/${kgId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'sensors',
      });
      check('kagero scenario gato sensors auth', kgGatoAuth.status === 200);
      const kgGatoTok = String(kgGatoAuth.json.token);
      const raiseKgPeri = await api(
        'POST',
        `/api/games/${kgId}/periscope`,
        { raised: true },
        kgGatoTok,
      );
      check('kagero scenario raise periscope', raiseKgPeri.status === 200);
      const kgPeriView = await api('GET', `/api/games/${kgId}/view`, undefined, kgGatoTok);
      const kgPeriContacts = (kgPeriView.json.view as { periscopeContacts?: Array<Json> })
        .periscopeContacts;
      check(
        'kagero peri paints destroyer class + kagero plate',
        Array.isArray(kgPeriContacts) &&
          kgPeriContacts.some(
            (c) => c.silhouetteClass === 'Destroyer' && c.silhouettePlate === 'kagero',
          ),
      );
    }

    {
      const psGame = await api('POST', '/api/games', {
        scenarioId: 'cavalla-shokaku-philippine-sea',
        name: 'Verify Cavalla × Shōkaku',
      });
      check('cavalla-shokaku scenario create', psGame.status === 200);
      const psId = String(psGame.json.gameId);
      const psUmp = await api('POST', `/api/games/${psId}/auth/umpire`, {
        password: 'umpire',
      });
      const psUTok = String(psUmp.json.token);
      const psView = await api('GET', `/api/games/${psId}/view`, undefined, psUTok);
      const psUmpireView = psView.json.view as {
        units?: Array<{
          id: string;
          name?: string;
          class?: string;
          classId?: string;
          faction?: string;
          heading?: number;
          speed?: number;
          lengthM?: number;
          beamM?: number;
          maxSpeed?: number;
          turnRate?: number;
          radarSignature?: string;
          accessToken?: string;
          position?: { lat: number; lon: number; depth: number };
          type?: string;
          flightLevel?: string;
        }>;
        vesselLinks?: Array<{
          unitId: string;
          playerVessel?: boolean;
          stations?: unknown[];
          accessToken?: string;
        }>;
        turn?: { gameTimeSeconds?: number };
      };
      check(
        'cavalla-shokaku clock starts ~11:00',
        psUmpireView.turn?.gameTimeSeconds === 39600,
      );
      const psUnits = psUmpireView.units ?? [];
      const cv = psUnits.find((u) => u.id === 'cv-shokaku');
      const dd = psUnits.find((u) => u.id === 'dd-urakaze');
      const ss = psUnits.find((u) => u.id === 'ss-cavalla');
      const zekeCap = psUnits.find((u) => u.id === 'ac-zeke-cap');
      check('philippine-sea shokaku present', Boolean(cv));
      check('philippine-sea urakaze present', Boolean(dd));
      check('philippine-sea cavalla present', Boolean(ss));
      check('philippine-sea zeke CAP present', Boolean(zekeCap));
      check(
        'philippine-sea shokaku NPC SE-bound seed',
        cv?.class === 'Aircraft Carrier' &&
          cv.classId === 'shokaku-class' &&
          cv.faction === 'Red' &&
          cv.heading === 135 &&
          cv.speed === 18 &&
          cv.lengthM === 258 &&
          cv.beamM === 26 &&
          cv.maxSpeed === 34 &&
          !cv.accessToken,
      );
      check(
        'philippine-sea zeke CAP NPC seed',
        zekeCap?.class === 'Fighter' &&
          zekeCap.classId === 'zeke-fighter' &&
          zekeCap.faction === 'Red' &&
          zekeCap.name === 'Zeke CAP' &&
          zekeCap.maxSpeed === 305 &&
          zekeCap.lengthM === 9 &&
          zekeCap.beamM === 12 &&
          zekeCap.turnRate === 12 &&
          zekeCap.radarSignature === 'small' &&
          zekeCap.heading === 225 &&
          zekeCap.speed === 198 &&
          !zekeCap.accessToken,
      );
      check(
        'philippine-sea urakaze playable Kagerō seed',
        dd?.class === 'Destroyer' &&
          dd.classId === 'kagero-class' &&
          dd.faction === 'Red' &&
          dd.name === 'Urakaze' &&
          dd.heading === 135 &&
          dd.lengthM === 119 &&
          dd.beamM === 11 &&
          dd.maxSpeed === 35 &&
          Boolean(dd.accessToken),
      );
      check(
        'philippine-sea cavalla playable Gato at PD',
        ss?.class === 'Fleet Submarine' &&
          ss.classId === 'gato-class' &&
          ss.faction === 'Blue' &&
          ss.name === 'USS Cavalla' &&
          ss.heading === 45 &&
          ss.position?.depth === 18 &&
          Boolean(ss.accessToken),
      );
      {
        const psSave = runtime.requireGame(psId);
        const cvUnit = psSave.units.find((u) => u.id === 'cv-shokaku')!;
        const ddUnit = psSave.units.find((u) => u.id === 'dd-urakaze')!;
        const ssUnit = psSave.units.find((u) => u.id === 'ss-cavalla')!;
        const zekeUnit = psSave.units.find((u) => u.id === 'ac-zeke-cap')!;
        check(
          'philippine-sea shokaku not player hull',
          !isV1PlayerHullClass(cvUnit.class) && !isV1PlayerUnit(cvUnit),
        );
        check(
          'philippine-sea zeke CAP is Aircraft Fighter NPC',
          zekeUnit.type === 'Aircraft' &&
            zekeUnit.class === 'Fighter' &&
            zekeUnit.flightLevel === 'medium' &&
            !isV1PlayerHullClass(zekeUnit.class) &&
            !isV1PlayerUnit(zekeUnit) &&
            isHydrophoneEmitter(zekeUnit) === false,
        );
        check(
          'philippine-sea urakaze is player Destroyer',
          isV1PlayerHullClass(ddUnit.class) &&
            isV1PlayerUnit(ddUnit) &&
            ddUnit.class === 'Destroyer',
        );
        check(
          'philippine-sea cavalla is player Fleet Submarine',
          isV1PlayerHullClass(ssUnit.class) &&
            isV1PlayerUnit(ssUnit) &&
            ssUnit.class === 'Fleet Submarine',
        );
      }
      const psLinks = psUmpireView.vesselLinks ?? [];
      const cvLink = psLinks.find((l) => l.unitId === 'cv-shokaku');
      const ddLink = psLinks.find((l) => l.unitId === 'dd-urakaze');
      const ssLink = psLinks.find((l) => l.unitId === 'ss-cavalla');
      const zekeLink = psLinks.find((l) => l.unitId === 'ac-zeke-cap');
      check(
        'philippine-sea shokaku link non-player',
        cvLink?.playerVessel === false &&
          Array.isArray(cvLink.stations) &&
          cvLink.stations.length === 0,
      );
      check(
        'philippine-sea zeke CAP link non-player',
        zekeLink?.playerVessel === false &&
          Array.isArray(zekeLink.stations) &&
          zekeLink.stations.length === 0,
      );
      check(
        'philippine-sea urakaze link playable',
        ddLink?.playerVessel === true &&
          Array.isArray(ddLink.stations) &&
          (ddLink.stations as unknown[]).length === 2,
      );
      check(
        'philippine-sea cavalla link playable',
        ssLink?.playerVessel === true &&
          Array.isArray(ssLink.stations) &&
          (ssLink.stations as unknown[]).length === 2,
      );

      const ddAuth = await api('POST', `/api/games/${psId}/auth/vessel`, {
        accessToken: 'urakaze-demo',
        password: 'red',
        stationId: 'controls',
      });
      check('philippine-sea urakaze controls auth', ddAuth.status === 200);

      const ssAuth = await api('POST', `/api/games/${psId}/auth/vessel`, {
        accessToken: 'cavalla-demo',
        password: 'blue',
        stationId: 'sensors',
      });
      check('philippine-sea cavalla sensors auth', ssAuth.status === 200);
      const ssTok = String(ssAuth.json.token);

      // Cavalla at PD (18 m) — hydrophone operational; hears Shōkaku + Urakaze
      // propellers only. Zeke CAP must never appear (aircraft excluded).
      const hydroView = await api('GET', `/api/games/${psId}/view`, undefined, ssTok);
      const hydroPic = hydroView.json.view as {
        hydrophoneOperational?: boolean;
        hydrophoneContacts?: Array<{ kind?: string; bearing?: number; rangeNm?: number }>;
      };
      check(
        'philippine-sea cavalla hydrophone operational at PD',
        hydroPic.hydrophoneOperational === true,
      );
      const propContacts = (hydroPic.hydrophoneContacts ?? []).filter(
        (c) => c.kind === 'propeller',
      );
      check(
        'philippine-sea hydrophone hears two waterborne hulls only',
        propContacts.length === 2,
        `got ${propContacts.length}`,
      );
      check(
        'philippine-sea hydrophone skips Zeke CAP fighter',
        propContacts.length === 2 &&
          (hydroPic.hydrophoneContacts ?? []).every((c) => c.kind !== undefined),
      );

      const raisePsPeri = await api(
        'POST',
        `/api/games/${psId}/periscope`,
        { raised: true },
        ssTok,
      );
      check('philippine-sea raise cavalla periscope', raisePsPeri.status === 200);
      const periView = await api('GET', `/api/games/${psId}/view`, undefined, ssTok);
      const periContacts = (periView.json.view as { periscopeContacts?: Array<Json> })
        .periscopeContacts;
      check(
        'philippine-sea peri sees carrier + kagero escort + zeke CAP',
        Array.isArray(periContacts) &&
          periContacts.some((c) => c.silhouetteClass === 'Aircraft Carrier') &&
          periContacts.some(
            (c) => c.silhouetteClass === 'Destroyer' && c.silhouettePlate === 'kagero',
          ) &&
          periContacts.some(
            (c) => c.silhouetteClass === 'Fighter' && c.silhouettePlate === 'zeke',
          ),
      );

      // Urakaze bridge lookout — same visual pipeline; Zeke CAP in range (~1.85 nm).
      const ddAuthLookout = await api('POST', `/api/games/${psId}/auth/vessel`, {
        accessToken: 'urakaze-demo',
        password: 'red',
        stationId: 'sensors',
      });
      check('philippine-sea urakaze sensors auth', ddAuthLookout.status === 200);
      const ddLookoutView = await api(
        'GET',
        `/api/games/${psId}/view`,
        undefined,
        String(ddAuthLookout.json.token),
      );
      const ddLookoutContacts = (
        ddLookoutView.json.view as { periscopeContacts?: Array<Json> }
      ).periscopeContacts;
      check(
        'philippine-sea urakaze lookout sees zeke CAP',
        Array.isArray(ddLookoutContacts) &&
          ddLookoutContacts.some(
            (c) => c.silhouetteClass === 'Fighter' && c.silhouettePlate === 'zeke',
          ),
      );
    }

    {
      const convoyGame = await api('POST', '/api/games', {
        scenarioId: 'cimarron-convoy-torpedo-test',
        name: 'Verify Cimarron Convoy',
      });
      check('cimarron convoy scenario create', convoyGame.status === 200);
      const convoyId = String(convoyGame.json.gameId);
      const convoyUmp = await api('POST', `/api/games/${convoyId}/auth/umpire`, {
        password: 'umpire',
      });
      const convoyUTok = String(convoyUmp.json.token);
      const convoyView = await api('GET', `/api/games/${convoyId}/view`, undefined, convoyUTok);
      const convoyUnits = (convoyView.json.view as {
        units?: Array<{ id: string; class?: string; lengthM?: number; beamM?: number }>;
      }).units ?? [];
      const oilers = convoyUnits.filter((u) => u.class === 'Oiler');
      check('cimarron convoy has 4 oilers', oilers.length === 4);
      check(
        'cimarron oilers 169×23',
        oilers.every((u) => u.lengthM === 169 && u.beamM === 23),
      );
      {
        const convoySave = runtime.requireGame(convoyId);
        const gatoUnit = convoySave.units.find((u) => u.id === 'ss-212')!;
        const oilerUnits = convoySave.units.filter((u) => u.class === 'Oiler');
        check('cimarron oilers seeded without turnRate override', oilerUnits.length === 4);
        check(
          'cimarron oilers turn like a large auxiliary, not a destroyer',
          oilerUnits.every((u) => u.turnRate === 4),
        );
        check(
          'cimarron oiler turnRate < Gato sub turnRate',
          oilerUnits.every((u) => u.turnRate < gatoUnit.turnRate),
        );
      }

      // --- Convoy group orders + break-formation ---
      {
        const formView = convoyView.json.view as {
          formations?: Array<{ id: string; name: string; orderedCourse: number; eot: string }>;
          units?: Array<{
            id: string;
            formationId?: string;
            formationDetached?: boolean;
            orderedCourse: number;
            orders?: { course?: number; eot?: string };
          }>;
        };
        check(
          'cimarron convoy formation listed',
          Array.isArray(formView.formations) &&
            formView.formations.some((f) => f.id === 'cimarron-column'),
        );
        const oilersInForm = (formView.units ?? []).filter(
          (u) => u.formationId === 'cimarron-column',
        );
        check('cimarron oilers in formation', oilersInForm.length === 4);
        check(
          'cimarron oilers start following',
          oilersInForm.every((u) => !u.formationDetached),
        );

        const groupApply = await api(
          'POST',
          `/api/games/${convoyId}/formations/cimarron-column/orders`,
          { course: 270, eot: 'ahead_full' },
          convoyUTok,
        );
        check('convoy group orders apply', groupApply.status === 200);
        const afterGroup = runtime.requireGame(convoyId);
        const followers = afterGroup.units.filter((u) => u.formationId === 'cimarron-column');
        check(
          'group apply sets orderedCourse on all followers',
          followers.every((u) => Math.abs(u.orderedCourse - 270) < 0.01),
        );
        check(
          'group apply queues EOT on all followers',
          followers.every((u) => u.orders.eot === 'ahead_full'),
        );
        check(
          'group apply does not snap bow heading',
          followers.every((u) => Math.abs(u.heading - 90) < 0.01),
        );
        const formState = afterGroup.formations?.find((f) => f.id === 'cimarron-column');
        check(
          'formation standing course/EOT updated',
          formState?.orderedCourse === 270 && formState?.eot === 'ahead_full',
        );

        const breakOut = await api(
          'POST',
          `/api/games/${convoyId}/units/ao-23/orders`,
          { course: 0, eot: 'ahead_1', breakFormation: true },
          convoyUTok,
        );
        check('break-formation ship orders', breakOut.status === 200);
        const afterBreak = runtime.requireGame(convoyId);
        const neosho = afterBreak.units.find((u) => u.id === 'ao-23')!;
        check('neosho detached', Boolean(neosho.formationDetached));
        check('neosho still has formationId', neosho.formationId === 'cimarron-column');
        check('neosho orderedCourse independent', Math.abs(neosho.orderedCourse - 0) < 0.01);
        check('neosho EOT independent', neosho.orders.eot === 'ahead_1');

        const groupAgain = await api(
          'POST',
          `/api/games/${convoyId}/formations/cimarron-column/orders`,
          { course: 180, eot: 'ahead_standard' },
          convoyUTok,
        );
        check('group apply after break', groupAgain.status === 200);
        const afterGroup2 = runtime.requireGame(convoyId);
        const neosho2 = afterGroup2.units.find((u) => u.id === 'ao-23')!;
        const cimarron2 = afterGroup2.units.find((u) => u.id === 'ao-22')!;
        check(
          'detached hull skips later group apply',
          Math.abs(neosho2.orderedCourse - 0) < 0.01 && neosho2.orders.eot === 'ahead_1',
        );
        check(
          'followers still take group apply',
          Math.abs(cimarron2.orderedCourse - 180) < 0.01 &&
            cimarron2.orders.eot === 'ahead_standard',
        );

        const rejoin = await api(
          'POST',
          `/api/games/${convoyId}/units/ao-23/orders`,
          { rejoinFormation: true },
          convoyUTok,
        );
        check('rejoin formation', rejoin.status === 200);
        const afterRejoin = runtime.requireGame(convoyId);
        const neosho3 = afterRejoin.units.find((u) => u.id === 'ao-23')!;
        check('neosho no longer detached', !neosho3.formationDetached);
        check(
          'rejoin resyncs to standing group course',
          Math.abs(neosho3.orderedCourse - 180) < 0.01,
        );
        check('rejoin resyncs pending group EOT', neosho3.orders.eot === 'ahead_standard');
      }

      const convoySub = await api('POST', `/api/games/${convoyId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'controls',
      });
      check('cimarron convoy gato controls join', convoySub.status === 200);
      const convoySensors = await api('POST', `/api/games/${convoyId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'sensors',
      });
      check('cimarron convoy gato sensors join', convoySensors.status === 200);
      const convoySensTok = String(convoySensors.json.token);

      // Surface + raise mast so radar and periscope both paint the oiler column.
      await api(
        'PATCH',
        `/api/games/${convoyId}/units/ss-212`,
        { position: { lat: 34.37504, lon: -120.0, depth: 0 } },
        convoyUTok,
      );
      const raiseConvoyPeri = await api(
        'POST',
        `/api/games/${convoyId}/periscope`,
        { raised: true },
        convoySensTok,
      );
      check('cimarron convoy raise periscope', raiseConvoyPeri.status === 200);

      const saveBefore = runtime.requireGame(convoyId);
      const gatoBefore = saveBefore.units.find((u) => u.id === 'ss-212')!;
      const periBefore = buildPeriscopeContacts(gatoBefore, saveBefore);
      const radarBefore = buildRadarContacts(gatoBefore, saveBefore);
      check(
        'cimarron peri paints multiple oilers',
        periBefore.contacts.length >= 2,
        `got ${periBefore.contacts.length}`,
      );
      check(
        'cimarron radar paints multiple oilers',
        radarBefore.contacts.length >= 2,
        `got ${radarBefore.contacts.length}`,
      );

      const periLabelById = new Map(periBefore.contacts.map((c) => [c.id, c.labelN]));
      const radarLabelByTarget = new Map(
        radarBefore.contacts.map((c) => {
          // Match radar↔peri via shared designation book on gato (same labelN).
          return [c.labelN, c.id] as const;
        }),
      );
      for (const pc of periBefore.contacts) {
        check(
          `cimarron radar shares peri labelN ${pc.labelN}`,
          radarLabelByTarget.has(pc.labelN),
        );
      }

      // Sort-by-range display order must not renumber: swap nearest/farthest oilers.
      const oilersLive = saveBefore.units.filter((u) => u.class === 'Oiler');
      const withRange = oilersLive
        .map((u) => ({
          u,
          rangeNm: bearingRangeNm(gatoBefore.position, u.position).rangeNm,
        }))
        .sort((a, b) => a.rangeNm - b.rangeNm);
      check('cimarron has ranged oilers', withRange.length >= 2);
      const nearest = withRange[0]!.u;
      const farthest = withRange[withRange.length - 1]!.u;
      const nearPos = { ...nearest.position };
      const farPos = { ...farthest.position };
      await api(
        'PATCH',
        `/api/games/${convoyId}/units/${nearest.id}`,
        { position: { lat: farPos.lat, lon: farPos.lon, depth: 0 } },
        convoyUTok,
      );
      await api(
        'PATCH',
        `/api/games/${convoyId}/units/${farthest.id}`,
        { position: { lat: nearPos.lat, lon: nearPos.lon, depth: 0 } },
        convoyUTok,
      );

      const saveAfter = runtime.requireGame(convoyId);
      const gatoAfter = saveAfter.units.find((u) => u.id === 'ss-212')!;
      const periAfter = buildPeriscopeContacts(gatoAfter, saveAfter);
      for (const c of periAfter.contacts) {
        const prev = periLabelById.get(c.id);
        check(
          `cimarron peri labelN stable after range swap (${c.id})`,
          prev === c.labelN,
          `before=${String(prev)} after=${c.labelN}`,
        );
      }
      // Display list may reorder, but Contact N is not the list index.
      const sortedByRange = [...periAfter.contacts].sort((a, b) => a.rangeNm - b.rangeNm);
      check(
        'cimarron Contact N not equal to range-sort index',
        sortedByRange.some((c, i) => c.labelN !== i + 1) || sortedByRange.length < 2,
      );
    }

    // Perfect-solution geometric hit vs a *moving* convoy target (regression for the
    // "accurate periscope inputs still miss" report): aim/course/speed/range taken
    // straight from ground truth right before firing must produce a geometric hit,
    // not a several-hundred-meter miss from targets/firer drifting during the
    // resolving turn. Force the dud roll off by checking CPA against the gate
    // directly instead of asserting on RNG-dependent `status: 'hit'`.
    {
      const perfectGame = await api('POST', '/api/games', {
        scenarioId: 'cimarron-convoy-torpedo-test',
        name: 'Verify Perfect Solution Hit',
      });
      check('perfect-solution game create', perfectGame.status === 200);
      const perfectId = String(perfectGame.json.gameId);
      const perfectUmp = await api('POST', `/api/games/${perfectId}/auth/umpire`, {
        password: 'umpire',
      });
      const perfectUTok = String(perfectUmp.json.token);
      const perfectSub = await api('POST', `/api/games/${perfectId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'controls',
      });
      const perfectTok = String(perfectSub.json.token);

      const perfectSave = runtime.requireGame(perfectId);
      const perfectGato = perfectSave.units.find((u) => u.id === 'ss-212')!;
      const perfectTarget = perfectSave.units.find((u) => u.id === 'ao-23')!; // USS Neosho
      const perfectLos = bearingRangeNm(perfectGato.position, perfectTarget.position);

      // Exactly what the operator would read off the periscope + recognition
      // manual right now, converted to true the same way the calculator does.
      const perfectOrder = {
        room: 'forward' as const,
        aimHeading: perfectLos.bearing,
        estimatedCourse: perfectTarget.heading,
        estimatedSpeedKn: perfectTarget.speed,
        estimatedRangeNm: perfectLos.rangeNm,
        estimatedLengthM: perfectTarget.lengthM,
        spreadCount: 1,
        spreadDeg: 2,
      };
      const perfectFire = await api(
        'POST',
        `/api/games/${perfectId}/orders`,
        { fireTorpedo: perfectOrder },
        perfectTok,
      );
      check('perfect-solution queue torpedo fire', perfectFire.status === 200);
      await api('POST', `/api/games/${perfectId}/turn/lock`, {}, perfectUTok);
      const perfectResolve = await api(
        'POST',
        `/api/games/${perfectId}/turn/resolve`,
        {},
        perfectUTok,
      );
      check('perfect-solution resolve', perfectResolve.status === 200);

      const perfectAfter = runtime.requireGame(perfectId);
      const perfectFish = perfectAfter.torpedoes.find(
        (t) => t.launchedTurn === 1 && t.firerUnitId === 'ss-212',
      );
      check('perfect-solution fish launched', !!perfectFish);
      const perfectGate = perfectTarget.beamM != null && perfectTarget.lengthM != null ? 90 : 0;
      check(
        'perfect solution lands within the geometric hit gate (CPA vs Neosho)',
        !!perfectFish &&
          perfectFish.closestApproachUnitId === 'ao-23' &&
          (perfectFish.closestApproachM ?? Infinity) <= perfectGate,
        `status=${perfectFish?.status} cpa=${perfectFish?.closestApproachM} target=${perfectFish?.closestApproachUnitId}`,
      );
      check(
        'perfect solution actually detonates (hit or dud — never a clean miss)',
        perfectFish?.status === 'hit' || perfectFish?.status === 'duded',
        `status=${perfectFish?.status}`,
      );
      await api('DELETE', `/api/saves/${perfectId}`);
    }

    {
      const deepDcGame = await api('POST', '/api/games', {
        scenarioId: 'deep-dc-test',
        name: 'Verify Deep DC',
      });
      check('deep-dc-test scenario create', deepDcGame.status === 200);
      const deepDcId = String(deepDcGame.json.gameId);
      const deepDcUmp = await api('POST', `/api/games/${deepDcId}/auth/umpire`, {
        password: 'umpire',
      });
      const deepDcUTok = String(deepDcUmp.json.token);
      const deepDcView = await api('GET', `/api/games/${deepDcId}/view`, undefined, deepDcUTok);
      const deepDcUnits = (deepDcView.json.view as {
        units?: Array<{
          id: string;
          class?: string;
          orderedDepth?: number;
          position?: { lat?: number; lon?: number; depth?: number };
          depthChargeLoad?: number;
        }>;
      }).units ?? [];
      const deepPorter = deepDcUnits.find((u) => u.id === 'dd-101');
      const deepGato = deepDcUnits.find((u) => u.id === 'ss-212');
      check(
        'deep-dc-test gato at deep keel',
        deepGato?.position?.depth === 90 && deepGato?.orderedDepth === 90,
      );
      check(
        'deep-dc-test porter overhead',
        deepPorter?.position?.lat === deepGato?.position?.lat &&
          deepPorter?.position?.lon === deepGato?.position?.lon &&
          deepPorter?.position?.depth === 0,
      );
      check('deep-dc-test porter has DC load', (deepPorter?.depthChargeLoad ?? 0) > 0);
      const deepDdCtrl = await api('POST', `/api/games/${deepDcId}/auth/vessel`, {
        accessToken: 'porter-demo',
        password: 'blue',
        stationId: 'controls',
      });
      check('deep-dc-test porter controls join', deepDdCtrl.status === 200);
      const deepDdSens = await api('POST', `/api/games/${deepDcId}/auth/vessel`, {
        accessToken: 'porter-demo',
        password: 'blue',
        stationId: 'sensors',
      });
      check('deep-dc-test porter sensors join', deepDdSens.status === 200);
      const deepSubCtrl = await api('POST', `/api/games/${deepDcId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'controls',
      });
      check('deep-dc-test gato controls join', deepSubCtrl.status === 200);
      const deepSubSens = await api('POST', `/api/games/${deepDcId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'sensors',
      });
      check('deep-dc-test gato sensors join', deepSubSens.status === 200);
      await api('DELETE', `/api/saves/${deepDcId}`);
    }

    const torpGame = await api('POST', '/api/games', {
      scenarioId: 'torpedo-fire-test',
      name: 'Verify Torpedo',
    });
    check('torpedo scenario create', torpGame.status === 200);
    const torpId = String(torpGame.json.gameId);
    const torpUmp = await api('POST', `/api/games/${torpId}/auth/umpire`, { password: 'umpire' });
    const torpUTok = String(torpUmp.json.token);
    const torpSub = await api('POST', `/api/games/${torpId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'controls',
    });
    const torpTok = String(torpSub.json.token);
    // Magazines: full rooms at start (6 fwd / 4 aft).
    {
      const magView = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      const magUnit = (magView.json.view as {
        unit?: {
          torpedoForward?: number;
          torpedoAft?: number;
          torpedoLoad?: number;
          torpedoForwardAwaitingReload?: boolean;
        };
      }).unit;
      check(
        'fleet sub starts with full rooms 6+4',
        magUnit?.torpedoForward === 6 &&
          magUnit?.torpedoAft === 4 &&
          magUnit?.torpedoLoad === 10 &&
          !magUnit?.torpedoForwardAwaitingReload,
      );
    }
    // Beam-aspect solution: aim north, est course E @ 14 kn / 1.5 nm → fire ~18°.
    const fire = await api('POST', `/api/games/${torpId}/orders`, {
      fireTorpedo: {
        room: 'forward',
        aimHeading: 0,
        estimatedCourse: 90,
        estimatedSpeedKn: 14,
        estimatedRangeNm: 1.5,
        estimatedLengthM: 115,
        spreadCount: 3,
        spreadDeg: 2,
      },
    }, torpTok);
    check('queue torpedo fire', fire.status === 200);
    await api('POST', `/api/games/${torpId}/turn/lock`, {}, torpUTok);
    const torpRes = await api('POST', `/api/games/${torpId}/turn/resolve`, {}, torpUTok);
    check('resolve torpedo turn', torpRes.status === 200);
    const torpView = await api('GET', `/api/games/${torpId}/view`, undefined, torpUTok);
    const uv = torpView.json.view as {
      torpedoes?: Array<{ status: string; heading?: number; path?: unknown[]; launchPosition?: unknown }>;
    };
    const fish = uv.torpedoes ?? [];
    check('umpire has torpedo tracks', fish.length >= 3);
    check(
      'torpedo has launch + path',
      Boolean(fish[0]?.launchPosition) && Array.isArray(fish[0]?.path) && (fish[0]!.path!.length >= 1),
    );
    const headings = [...new Set(fish.map((f) => Math.round(((f.heading ?? 0) % 360) + 360) % 360))];
    const expectedFan = torpedoSpreadHeadings(beamSol.fireHeading, 3, 2).map((h) =>
      Math.round(((h % 360) + 360) % 360),
    );
    check(
      'spread fan follows solution fire heading',
      expectedFan.every((h) => headings.includes(h)),
      `got ${headings.join(',')} want ${expectedFan.join(',')}`,
    );
    check(
      'fish not raw aim (solution lead)',
      !headings.includes(0) || expectedFan.includes(0),
      `got ${headings.join(',')}`,
    );

    // Magazines deplete; reload delay; umpire rearm.
    {
      const afterFire = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      const afterUnit = (afterFire.json.view as {
        unit?: {
          torpedoForward?: number;
          torpedoAft?: number;
          torpedoForwardAwaitingReload?: boolean;
          torpedoForwardReloadTurnsRemaining?: number;
        };
      }).unit;
      check(
        'forward room depleted by spread',
        afterUnit?.torpedoForward === 3 && afterUnit?.torpedoAft === 4,
        `fwd=${afterUnit?.torpedoForward} aft=${afterUnit?.torpedoAft}`,
      );
      check(
        'forward awaiting reload after fire',
        afterUnit?.torpedoForwardAwaitingReload === true &&
          (afterUnit?.torpedoForwardReloadTurnsRemaining ?? 0) === 0,
      );
      const blocked = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'forward',
            aimHeading: 0,
            estimatedCourse: 90,
            estimatedSpeedKn: 14,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
            spreadCount: 1,
          },
        },
        torpTok,
      );
      check('cannot fire forward while awaiting reload', blocked.status === 400);
      const aftOk = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'aft',
            aimHeading: 180,
            estimatedCourse: 90,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
            spreadCount: 1,
          },
        },
        torpTok,
      );
      check('aft room still fireable independently', aftOk.status === 200);
      await api('POST', `/api/games/${torpId}/orders`, { fireTorpedo: null }, torpTok);

      const reloadStart = await api(
        'POST',
        `/api/games/${torpId}/torpedo-reload`,
        { room: 'forward' },
        torpTok,
      );
      check('start forward reload', reloadStart.status === 200);
      check(
        'reload countdown set to 5',
        (reloadStart.json as { torpedoForwardReloadTurnsRemaining?: number })
          .torpedoForwardReloadTurnsRemaining === 5,
      );
      for (let i = 0; i < 5; i++) {
        await api('POST', `/api/games/${torpId}/turn/lock`, {}, torpUTok);
        await api('POST', `/api/games/${torpId}/turn/resolve`, {}, torpUTok);
      }
      const afterReload = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      const reloaded = (afterReload.json.view as {
        unit?: {
          torpedoForward?: number;
          torpedoForwardAwaitingReload?: boolean;
          torpedoForwardReloadTurnsRemaining?: number;
        };
      }).unit;
      check(
        'forward reload completes after 5 turns',
        reloaded?.torpedoForwardAwaitingReload === false &&
          (reloaded?.torpedoForwardReloadTurnsRemaining ?? 0) === 0 &&
          reloaded?.torpedoForward === 3,
      );

      const rearm = await api('POST', `/api/games/${torpId}/units/ss-212/rearm`, {}, torpUTok);
      check('umpire rearm torpedoes', rearm.status === 200);
      check(
        'rearm restores full 6+4',
        (rearm.json as { torpedoForward?: number; torpedoAft?: number }).torpedoForward === 6 &&
          (rearm.json as { torpedoAft?: number }).torpedoAft === 4,
      );

      // Firing arcs: aft ahead rejected; aft astern accepted; forward abeam rejected.
      const aftAheadReject = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'aft',
            aimHeading: 0,
            estimatedCourse: 90,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
          },
        },
        torpTok,
      );
      check('reject aft fire ahead of bow', aftAheadReject.status === 400);
      const fwdAbeamReject = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'forward',
            aimHeading: 90,
            estimatedCourse: 0,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
          },
        },
        torpTok,
      );
      check('reject forward fire abeam', fwdAbeamReject.status === 400);
      const aftAsternOk = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'aft',
            aimHeading: 180,
            estimatedCourse: 90,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
          },
        },
        torpTok,
      );
      check('queue aft fire astern', aftAsternOk.status === 200);
      await api('POST', `/api/games/${torpId}/orders`, { fireTorpedo: null }, torpTok);

      // Queue in-arc, then turn the hull out of the cone before resolve: the
      // salvo must be dropped without spending fish, and the crew told.
      const preTurnView = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      const preTurnUnit = (preTurnView.json.view as {
        unit?: { heading?: number; torpedoAft?: number };
      }).unit;
      const hdg0 = Math.round(Number(preTurnUnit?.heading) || 0);
      const aftBefore = preTurnUnit?.torpedoAft ?? 0;
      // Gyro −40° at order time (inside the cone); a starboard swing walks it out.
      const swungAim = (hdg0 + 140) % 360;
      const queuedInArc = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'aft',
            aimHeading: swungAim,
            estimatedCourse: 90,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
          },
        },
        torpTok,
      );
      check('queue in-arc aft salvo before hull turn', queuedInArc.status === 200);
      const swing = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        { course: (hdg0 + 90) % 360 },
        torpTok,
      );
      check('order course swing out of aft arc', swing.status === 200);
      await api('POST', `/api/games/${torpId}/turn/lock`, {}, torpUTok);
      const swingRes = await api('POST', `/api/games/${torpId}/turn/resolve`, {}, torpUTok);
      check('resolve turn with out-of-arc queued salvo', swingRes.status === 200);
      const blockedView = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      const blockedUnit = (blockedView.json.view as {
        unit?: {
          heading?: number;
          torpedoAft?: number;
          torpedoAftAwaitingReload?: boolean;
          torpedoArcBlock?: { room?: string; halfDeg?: number; gyroDeg?: number };
        };
      }).unit;
      check(
        'hull turned out of aft arc',
        Math.abs(
          shortestBearingDelta((Number(blockedUnit?.heading) || 0) + 180, swungAim),
        ) > TORPEDO_AFT_ARC_HALF_DEG,
        `hdg=${blockedUnit?.heading} from ${hdg0}`,
      );
      check(
        'out-of-arc resolve consumes no fish',
        blockedUnit?.torpedoAft === aftBefore &&
          blockedUnit?.torpedoAftAwaitingReload === false,
        `aft=${blockedUnit?.torpedoAft} want ${aftBefore}`,
      );
      check(
        'crew sees blocked-salvo notice',
        blockedUnit?.torpedoArcBlock?.room === 'aft' &&
          blockedUnit?.torpedoArcBlock?.halfDeg === TORPEDO_AFT_ARC_HALF_DEG &&
          Math.abs(Number(blockedUnit?.torpedoArcBlock?.gyroDeg) || 0) >
            TORPEDO_AFT_ARC_HALF_DEG,
        JSON.stringify(blockedUnit?.torpedoArcBlock),
      );
      const blockedLog = await api('GET', `/api/games/${torpId}/view`, undefined, torpUTok);
      check(
        'umpire log records blocked torpedo order',
        ((blockedLog.json.view as { combatLog?: Array<{ summary?: string }> }).combatLog ?? [])
          .some((e) => (e.summary ?? '').includes('torpedo order blocked')),
      );
      const hdg1 = Math.round(Number(blockedUnit?.heading) || 0);
      const requeued = await api(
        'POST',
        `/api/games/${torpId}/orders`,
        {
          fireTorpedo: {
            room: 'aft',
            aimHeading: (hdg1 + 180) % 360,
            estimatedCourse: 90,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 1.5,
            estimatedLengthM: 115,
          },
        },
        torpTok,
      );
      check('re-aimed aft salvo accepted', requeued.status === 200);
      const clearedView = await api('GET', `/api/games/${torpId}/view`, undefined, torpTok);
      check(
        'blocked-salvo notice clears on new order',
        (clearedView.json.view as { unit?: { torpedoArcBlock?: unknown } }).unit
          ?.torpedoArcBlock === undefined,
      );
      await api('POST', `/api/games/${torpId}/orders`, { fireTorpedo: null }, torpTok);
    }

    await api('DELETE', `/api/saves/${torpId}`);

    // Persist trails + endurance: fish exhaust after max run and stay on GT across later turns.
    {
      const { advanceTorpedo, createTorpedoTrack, TORPEDO_DEFAULT_DEPTH_M, TORPEDO_MAX_RUN_NM } =
        await import('@war-patrol/shared');
      const fish0 = createTorpedoTrack({
        id: 't-endurance',
        firerUnitId: 'ss-212',
        position: { lat: 34.37, lon: -120.0, depth: TORPEDO_DEFAULT_DEPTH_M },
        heading: 0,
        runDepthM: TORPEDO_DEFAULT_DEPTH_M,
        launchedTurn: 1,
        estimatedCourse: 0,
        estimatedSpeedKn: 14,
        estimatedRangeNm: 2,
        estimatedLengthM: 115,
      });
      check('fish starts at max run', Math.abs(fish0.remainingRunNm - TORPEDO_MAX_RUN_NM) < 1e-9);
      // One long step past max run → expired / exhausted.
      const spent = advanceTorpedo(fish0, 3600);
      check('fish exhausts after max run', spent.status === 'expired' && spent.remainingRunNm === 0);

      const persistGame = await api('POST', '/api/games', {
        scenarioId: 'torpedo-fire-test',
        name: 'Verify Torpedo Persist',
      });
      check('persist scenario create', persistGame.status === 200);
      const persistId = String(persistGame.json.gameId);
      const persistUmp = await api('POST', `/api/games/${persistId}/auth/umpire`, {
        password: 'umpire',
      });
      const persistUTok = String(persistUmp.json.token);
      const persistSub = await api('POST', `/api/games/${persistId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'controls',
      });
      const persistTok = String(persistSub.json.token);
      // Park both hulls still; fire north into empty water so fish miss and run out.
      await api(
        'PATCH',
        `/api/games/${persistId}/units/dd-101`,
        { speed: 0, heading: 90, position: { lat: 34.36, lon: -119.95 } },
        persistUTok,
      );
      await api(
        'PATCH',
        `/api/games/${persistId}/units/ss-212`,
        { speed: 0, heading: 0, position: { lat: 34.37, lon: -120.0, depth: 20 } },
        persistUTok,
      );
      await api(
        'POST',
        `/api/games/${persistId}/orders`,
        {
          eot: 'stop',
          fireTorpedo: {
            aimHeading: 0,
            estimatedCourse: 0,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 4,
            estimatedLengthM: 115,
            spreadCount: 1,
            spreadDeg: 2,
          },
        },
        persistTok,
      );
      await api('POST', `/api/games/${persistId}/turn/lock`, {}, persistUTok);
      await api('POST', `/api/games/${persistId}/turn/resolve`, {}, persistUTok);
      // ~2.3 nm/turn at 46 kn × 180 s; 4.5 nm exhausts within a few resolves.
      let exhausted = false;
      for (let i = 0; i < 5 && !exhausted; i++) {
        const v = await api('GET', `/api/games/${persistId}/view`, undefined, persistUTok);
        const fishList =
          ((v.json.view as { torpedoes?: Array<{ status: string; id: string }> }).torpedoes) ??
          [];
        exhausted = fishList.some((f) => f.status === 'expired');
        if (!exhausted) {
          await api('POST', `/api/games/${persistId}/turn/lock`, {}, persistUTok);
          await api('POST', `/api/games/${persistId}/turn/resolve`, {}, persistUTok);
        }
      }
      check('fish reaches exhausted status', exhausted);
      const beforeExtra = await api('GET', `/api/games/${persistId}/view`, undefined, persistUTok);
      const beforeFish =
        ((beforeExtra.json.view as { torpedoes?: Array<{ id: string; status: string }> })
          .torpedoes) ?? [];
      const expiredIds = beforeFish.filter((f) => f.status === 'expired').map((f) => f.id);
      check('exhausted fish present before extra turns', expiredIds.length >= 1);
      // Empty resolves — historical trails must remain.
      for (let i = 0; i < 3; i++) {
        await api('POST', `/api/games/${persistId}/turn/lock`, {}, persistUTok);
        await api('POST', `/api/games/${persistId}/turn/resolve`, {}, persistUTok);
      }
      const afterExtra = await api('GET', `/api/games/${persistId}/view`, undefined, persistUTok);
      const afterFish =
        ((afterExtra.json.view as { torpedoes?: Array<{ id: string; status: string }> })
          .torpedoes) ?? [];
      check(
        'exhausted fish persist on GT',
        expiredIds.every((id) => afterFish.some((f) => f.id === id && f.status === 'expired')),
        `missing ${expiredIds.filter((id) => !afterFish.some((f) => f.id === id)).join(',')}`,
      );
      await api('DELETE', `/api/saves/${persistId}`);
    }

    // Wrong solution → miss: parked DD dead ahead; bogus lead from course/speed estimates
    // steers fish off the LOS so geometry never contacts.
    {
      const missGame = await api('POST', '/api/games', {
        scenarioId: 'torpedo-fire-test',
        name: 'Verify Torpedo Wrong Solution Miss',
      });
      check('wrong-solution game create', missGame.status === 200);
      const missId = String(missGame.json.gameId);
      const missUmp = await api('POST', `/api/games/${missId}/auth/umpire`, { password: 'umpire' });
      const missUTok = String(missUmp.json.token);
      const missSub = await api('POST', `/api/games/${missId}/auth/vessel`, {
        accessToken: 'gato-demo',
        password: 'red',
        stationId: 'controls',
      });
      const missTok = String(missSub.json.token);
      const missDd = await api('POST', `/api/games/${missId}/auth/vessel`, {
        accessToken: 'porter-demo',
        password: 'blue',
        stationId: 'controls',
      });
      const missDdTok = String(missDd.json.token);
      await api(
        'PATCH',
        `/api/games/${missId}/units/dd-101`,
        { speed: 0, heading: 90, position: { lat: 34.382, lon: -120.0 } },
        missUTok,
      );
      await api(
        'PATCH',
        `/api/games/${missId}/units/ss-212`,
        { speed: 0, heading: 0, position: { lat: 34.378, lon: -120.0, depth: 20 } },
        missUTok,
      );
      await api('POST', `/api/games/${missId}/orders`, { eot: 'stop' }, missDdTok);
      // Aim true north (LOS) but invent a fast eastbound target → large lead away from hull.
      const wrongSol = torpedoFireHeadingFromSolution({
        aimHeading: 0,
        estimatedCourse: 90,
        estimatedSpeedKn: 28,
        estimatedRangeNm: 0.24,
      });
      check(
        'wrong solution produces lead off LOS',
        wrongSol.solvable && Math.abs(wrongSol.fireHeading) > 10,
        `fire=${wrongSol.fireHeading}`,
      );
      await api(
        'POST',
        `/api/games/${missId}/orders`,
        {
          eot: 'stop',
          fireTorpedo: {
            aimHeading: 0,
            estimatedCourse: 90,
            estimatedSpeedKn: 28,
            estimatedRangeNm: 0.24,
            estimatedLengthM: 115,
            spreadCount: 1,
            spreadDeg: 2,
          },
        },
        missTok,
      );
      await api('POST', `/api/games/${missId}/turn/lock`, {}, missUTok);
      await api('POST', `/api/games/${missId}/turn/resolve`, {}, missUTok);
      let sawHit = false;
      let sawExpired = false;
      for (let i = 0; i < 6 && !sawHit && !sawExpired; i++) {
        const v = await api('GET', `/api/games/${missId}/view`, undefined, missUTok);
        const list =
          ((v.json.view as { torpedoes?: Array<{ status: string; heading?: number }> }).torpedoes) ??
          [];
        sawHit = list.some((f) => f.status === 'hit' || f.status === 'duded');
        sawExpired = list.some((f) => f.status === 'expired');
        if (i === 0 && list[0]) {
          check(
            'wrong-solution fish ran lead heading',
            Math.abs((list[0].heading ?? 0) - wrongSol.fireHeading) < 1,
            `hdg=${list[0].heading} want≈${wrongSol.fireHeading}`,
          );
        }
        if (!sawHit && !sawExpired) {
          await api('POST', `/api/games/${missId}/turn/lock`, {}, missUTok);
          await api('POST', `/api/games/${missId}/turn/resolve`, {}, missUTok);
        }
      }
      check('wrong solution misses parked target', !sawHit, `hit=${sawHit} expired=${sawExpired}`);
      {
        const missView = await api('GET', `/api/games/${missId}/view`, undefined, missUTok);
        const log =
          ((missView.json.view as { combatLog?: Array<{ kind: string; summary: string }> })
            .combatLog) ?? [];
        const missLine = log.find((e) => e.kind === 'torpedo_miss');
        check(
          'wrong-solution umpire miss log has CPA',
          !!missLine &&
            /MISSED/.test(missLine.summary) &&
            /CPA \d+ m \(\d+ yd\)/.test(missLine.summary),
          missLine?.summary ?? 'no torpedo_miss line',
        );
        if (missLine) {
          const missFish =
            (
              (missView.json.view as {
                torpedoes?: Array<{
                  status: string;
                  closestApproachM?: number;
                  closestApproachUnitId?: string;
                  closestApproachUnitName?: string;
                }>;
              }).torpedoes
            ) ?? [];
          const expired = missFish.find((f) => f.status === 'expired');
          check(
            'expired fish stores nearest-contact CPA fields',
            !!expired &&
              expired.closestApproachM != null &&
              !!expired.closestApproachUnitId &&
              !!expired.closestApproachUnitName,
            expired
              ? `cpa=${expired.closestApproachM} id=${expired.closestApproachUnitId} name=${expired.closestApproachUnitName}`
              : 'no expired fish',
          );
          check(
            'miss log names stored nearest contact',
            !!expired?.closestApproachUnitName &&
              missLine.summary.includes(expired.closestApproachUnitName),
            missLine.summary,
          );
        }
      }
      await api('DELETE', `/api/saves/${missId}`);
    }

    // Hit-audio path on a fresh game: park Porter dead ahead, stop both, one fish → hit.
    // Firer + target Controls must get bridgeDetonations kind torpedo_hit (explosion.wav cue).
    // Correct stationary solution (speed 0) → fire heading = aim → geometry hit.
    const hitGame = await api('POST', '/api/games', {
      scenarioId: 'torpedo-fire-test',
      name: 'Verify Torpedo Hit Audio',
    });
    check('torpedo hit-audio game create', hitGame.status === 200);
    const hitId = String(hitGame.json.gameId);
    const hitUmp = await api('POST', `/api/games/${hitId}/auth/umpire`, { password: 'umpire' });
    const hitUTok = String(hitUmp.json.token);
    const hitSub = await api('POST', `/api/games/${hitId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'controls',
    });
    const hitTok = String(hitSub.json.token);
    const hitDd = await api('POST', `/api/games/${hitId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'controls',
    });
    const hitDdTok = String(hitDd.json.token);
    await api(
      'PATCH',
      `/api/games/${hitId}/units/dd-101`,
      { speed: 0, heading: 90, position: { lat: 34.382, lon: -120.0 } },
      hitUTok,
    );
    await api(
      'PATCH',
      `/api/games/${hitId}/units/ss-212`,
      { speed: 0, heading: 0, position: { lat: 34.378, lon: -120.0, depth: 20 } },
      hitUTok,
    );
    await api('POST', `/api/games/${hitId}/orders`, { eot: 'stop' }, hitDdTok);
    let torpHit = false;
    let hitAttempts = 0;
    while (!torpHit && hitAttempts < 6) {
      hitAttempts += 1;
      await api('POST', `/api/games/${hitId}/units/ss-212/rearm`, {}, hitUTok);
      await api(
        'PATCH',
        `/api/games/${hitId}/units/dd-101`,
        { speed: 0, heading: 90, position: { lat: 34.382, lon: -120.0 } },
        hitUTok,
      );
      await api(
        'PATCH',
        `/api/games/${hitId}/units/ss-212`,
        { speed: 0, heading: 0, position: { lat: 34.378, lon: -120.0, depth: 20 } },
        hitUTok,
      );
      await api('POST', `/api/games/${hitId}/orders`, { eot: 'stop' }, hitDdTok);
      const hitFire = await api(
        'POST',
        `/api/games/${hitId}/orders`,
        {
          eot: 'stop',
          fireTorpedo: {
            room: 'forward',
            aimHeading: 0,
            estimatedCourse: 0,
            estimatedSpeedKn: 0,
            estimatedRangeNm: 4,
            estimatedLengthM: 115,
            spreadCount: 1,
            spreadDeg: 2,
          },
        },
        hitTok,
      );
      if (hitFire.status !== 200) break;
      await api('POST', `/api/games/${hitId}/turn/lock`, {}, hitUTok);
      await api('POST', `/api/games/${hitId}/turn/resolve`, {}, hitUTok);
      const hitUmpView = await api('GET', `/api/games/${hitId}/view`, undefined, hitUTok);
      const hitUv = hitUmpView.json.view as {
        torpedoes?: Array<{ status: string }>;
        recentDetonations?: Array<{ kind?: string }>;
      };
      torpHit =
        (hitUv.torpedoes ?? []).some((f) => f.status === 'hit') ||
        (hitUv.recentDetonations ?? []).some((d) => d.kind === 'torpedo_hit');
    }
    check('parked torpedo hit (audio cue path)', torpHit, `attempts=${hitAttempts}`);

    const gatoHitView = await api('GET', `/api/games/${hitId}/view`, undefined, hitTok);
    const gatoBridge = (
      gatoHitView.json.view as {
        bridgeDetonations?: Array<{ id: string; kind: string; rangeNm: number }>;
      }
    ).bridgeDetonations;
    const gatoHits = (gatoBridge ?? []).filter((d) => d.kind === 'torpedo_hit');
    check(
      'firer Controls gets torpedo_hit bridge cue',
      gatoHits.length >= 1,
      `bridge=${JSON.stringify(gatoBridge)}`,
    );

    const porterHitView = await api('GET', `/api/games/${hitId}/view`, undefined, hitDdTok);
    const porterBridge = (
      porterHitView.json.view as {
        bridgeDetonations?: Array<{ id: string; kind: string; rangeNm: number }>;
      }
    ).bridgeDetonations;
    const porterHits = (porterBridge ?? []).filter((d) => d.kind === 'torpedo_hit');
    check(
      'target Controls gets torpedo_hit bridge cue',
      porterHits.length >= 1,
      `bridge=${JSON.stringify(porterBridge)}`,
    );

    await api('DELETE', `/api/saves/${hitId}`);

    const dcGame = await api('POST', '/api/games', {
      scenarioId: 'depth-charge-audio-test',
      name: 'Verify DC',
    });
    check('dc scenario create', dcGame.status === 200);
    const dcId = String(dcGame.json.gameId);
    const dcUmp = await api('POST', `/api/games/${dcId}/auth/umpire`, { password: 'umpire' });
    const dcUTok = String(dcUmp.json.token);
    const dcDd = await api('POST', `/api/games/${dcId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'controls',
    });
    const dcTok = String(dcDd.json.token);
    const drop = await api(
      'POST',
      `/api/games/${dcId}/orders`,
      { dropDepthCharges: { pattern: 'pattern_3', depthSettingM: 50 } },
      dcTok,
    );
    check('queue depth charges', drop.status === 200);
    await api('POST', `/api/games/${dcId}/turn/lock`, {}, dcUTok);
    // May need multiple resolves for sink — force short path by resolving once then checking tracks
    const dcRes = await api('POST', `/api/games/${dcId}/turn/resolve`, {}, dcUTok);
    check('resolve dc turn', dcRes.status === 200);

    // Finite rack depletes; reload delay; umpire rearm.
    {
      const rackView = await api('GET', `/api/games/${dcId}/view`, undefined, dcTok);
      const rackUnit = (rackView.json.view as {
        unit?: {
          depthChargeLoad?: number;
          depthChargeAwaitingReload?: boolean;
          depthChargeReloadTurnsRemaining?: number;
        };
      }).unit;
      check(
        'DC rack depleted by pattern_3 (6)',
        rackUnit?.depthChargeLoad === 18 && rackUnit?.depthChargeAwaitingReload === true,
        `load=${rackUnit?.depthChargeLoad} awaiting=${rackUnit?.depthChargeAwaitingReload}`,
      );
      const blockedDc = await api(
        'POST',
        `/api/games/${dcId}/orders`,
        { dropDepthCharges: { pattern: 'single', depthSettingM: 50 } },
        dcTok,
      );
      check('cannot drop while awaiting DC reload', blockedDc.status === 400);
      const dcReload = await api(
        'POST',
        `/api/games/${dcId}/depth-charge-reload`,
        {},
        dcTok,
      );
      check('start DC rack reload', dcReload.status === 200);
      check(
        'DC reload countdown 5',
        (dcReload.json as { depthChargeReloadTurnsRemaining?: number })
          .depthChargeReloadTurnsRemaining === 5,
      );
      // Reload completion + rearm use a dedicated game below so this game's
      // detonation retention / along-track geometry stay intact for audio checks.
    }

    const dcView = await api('GET', `/api/games/${dcId}/view`, undefined, dcUTok);
    const dcv = dcView.json.view as {
      depthCharges?: Array<{
        status: string;
        launchPosition?: { lat: number; lon: number };
        path?: unknown[];
        firerUnitId?: string;
      }>;
      units?: Array<{ id: string; position: { lat: number; lon: number } }>;
      recentDetonations?: Array<{ position: { lat: number; lon: number }; firerUnitId: string }>;
      trails?: Array<{ unitId: string; points: Array<{ lat: number; lon: number; turnNumber: number }> }>;
    };
    const charges = dcv.depthCharges ?? [];
    check('umpire has depth-charge tracks', charges.length >= 1);
    check('dc has launch origin', Boolean(charges[0]?.launchPosition));
    // Sink rate 3.5 m/s × 180 s >> 50 m — should detonate same turn
    check(
      'dc detonated or spent same turn',
      charges.some((c) => c.status === 'spent' || c.status === 'detonated') ||
        (dcv.recentDetonations?.length ?? 0) > 0,
    );

    // Launch origins spaced along firer's start→end move (trail, not one pile).
    const umpireFull = dcView.json.view as {
      units: Array<{ id: string; position: { lat: number; lon: number } }>;
      trails: Array<{ unitId: string; points: Array<{ lat: number; lon: number; turnNumber: number }> }>;
      depthCharges: Array<{ launchPosition: { lat: number; lon: number } }>;
      recentDetonations: Array<{ position: { lat: number; lon: number } }>;
      combatLog?: Array<{ kind: string; summary: string }>;
    };
    const porter = umpireFull.units.find((u) => u.id === 'dd-101');
    const trailPts = umpireFull.trails.find((t) => t.unitId === 'dd-101')?.points ?? [];
    const startPt = trailPts.find((p) => p.turnNumber === 0) ?? trailPts[0];
    const launches = (umpireFull.depthCharges ?? [])
      .map((c) => c.launchPosition)
      .filter(Boolean) as Array<{ lat: number; lon: number }>;
    check('dc pattern trail has multiple drop points', launches.length >= 3, `n=${launches.length}`);
    if (porter && startPt && launches.length >= 2) {
      const { bearingRangeNm, eastNorthMeters } = await import('@war-patrol/shared');
      // Span of drop points should be a meaningful fraction of the move, not a midpoint pile.
      let maxPairNm = 0;
      for (let i = 0; i < launches.length; i++) {
        for (let j = i + 1; j < launches.length; j++) {
          const { rangeNm } = bearingRangeNm(launches[i]!, launches[j]!);
          if (rangeNm > maxPairNm) maxPairNm = rangeNm;
        }
      }
      const { rangeNm: moveNm } = bearingRangeNm(startPt, porter.position);
      check(
        'dc drop trail spans along move',
        moveNm > 0.05 && maxPairNm > moveNm * 0.35,
        `move=${moveNm.toFixed(3)}nm span=${maxPairNm.toFixed(3)}nm`,
      );
      // First/last drops should sit nearer their respective ends than a single midpoint pile.
      const sorted = [...launches].sort((a, b) => {
        const da = eastNorthMeters(startPt, a);
        const db = eastNorthMeters(startPt, b);
        const move = eastNorthMeters(startPt, porter.position);
        const moveLen2 = move.east * move.east + move.north * move.north || 1;
        const ta = (da.east * move.east + da.north * move.north) / moveLen2;
        const tb = (db.east * move.east + db.north * move.north) / moveLen2;
        return ta - tb;
      });
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const { rangeNm: firstToStart } = bearingRangeNm(startPt, first);
      const { rangeNm: lastToEnd } = bearingRangeNm(porter.position, last);
      const mid = {
        lat: (startPt.lat + porter.position.lat) / 2,
        lon: (startPt.lon + porter.position.lon) / 2,
      };
      const { rangeNm: firstToMid } = bearingRangeNm(mid, first);
      const { rangeNm: lastToMid } = bearingRangeNm(mid, last);
      check(
        'dc trail not piled at midpoint',
        firstToStart < firstToMid && lastToEnd < lastToMid,
        `firstToStart=${firstToStart.toFixed(3)} firstToMid=${firstToMid.toFixed(3)} lastToEnd=${lastToEnd.toFixed(3)} lastToMid=${lastToMid.toFixed(3)}`,
      );
    } else {
      check('dc drop trail spans along move', false, 'missing porter/start/launches');
      check('dc trail not piled at midpoint', false, 'missing porter/start/launches');
    }

    // Non-firer Controls hears close detonations (range to this hull, not only dropper).
    const gatoTok = await api('POST', `/api/games/${dcId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'controls',
    });
    check('gato controls auth for bridge audio', gatoTok.status === 200);
    const gatoView = await api(
      'GET',
      `/api/games/${dcId}/view`,
      undefined,
      String(gatoTok.json.token),
    );
    const gBridge = (gatoView.json.view as { bridgeDetonations?: unknown[] }).bridgeDetonations;
    check(
      'non-firer Controls gets close DC bridge audio',
      Array.isArray(gBridge) && gBridge.length > 0,
      `bridge=${JSON.stringify(gBridge)}`,
    );
    // Prove cue is range-based (has rangeNm) and not an own-weapon-only channel.
    const gBridgeTyped = (gBridge ?? []) as Array<{ id: string; rangeNm: number; bearing: number }>;
    check(
      'non-firer bridge cues expose range not firer id',
      gBridgeTyped.every(
        (c) =>
          typeof c.rangeNm === 'number' &&
          c.rangeNm <= DEPTH_CHARGE_CONTROLS_AUDIBLE_NM &&
          !('firerUnitId' in c) &&
          typeof c.id === 'string',
      ),
      JSON.stringify(gBridgeTyped),
    );
    const porterTok2 = await api('POST', `/api/games/${dcId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'controls',
    });
    const porterView2 = await api(
      'GET',
      `/api/games/${dcId}/view`,
      undefined,
      String(porterTok2.json.token),
    );
    const pBridge = (porterView2.json.view as { bridgeDetonations?: unknown[] }).bridgeDetonations;
    check(
      'firer Controls also gets close DC bridge audio',
      Array.isArray(pBridge) && pBridge.length > 0,
      `bridge=${JSON.stringify(pBridge)}`,
    );

    // Hydrophone on sub Sensors also lists depth_charge contacts in range.
    // Restore sensors if the pattern stunned them — hydrophone path is independent of damage.
    await api(
      'PATCH',
      `/api/games/${dcId}/units/ss-212`,
      { subsystems: { sensors: 'intact', propulsion: 'intact' }, condition: 'afloat', health: 100 },
      dcUTok,
    );

    const gatoSens = await api('POST', `/api/games/${dcId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'sensors',
    });
    const gatoHydro = await api(
      'GET',
      `/api/games/${dcId}/view`,
      undefined,
      String(gatoSens.json.token),
    );
    const hydro = (gatoHydro.json.view as { hydrophoneContacts?: Array<{ kind: string }> })
      .hydrophoneContacts;
    check(
      'hydrophone hears depth_charge in range',
      Array.isArray(hydro) && hydro.some((c) => c.kind === 'depth_charge'),
    );

    // Persistent GT DC markers (like torpedo trails): spent charges survive later resolves.
    const beforePersistView = await api('GET', `/api/games/${dcId}/view`, undefined, dcUTok);
    const beforePersist = beforePersistView.json.view as {
      depthCharges?: Array<{ id: string; status: string }>;
      historySnapshots?: Array<{
        turnNumber: number;
        depthCharges?: Array<{ id: string }>;
        units?: unknown[];
      }>;
    };
    const spentIds = (beforePersist.depthCharges ?? [])
      .filter((c) => c.status === 'spent' || c.status === 'detonated')
      .map((c) => c.id);
    check('spent DC markers present before extra turns', spentIds.length >= 1);
    const snap0 = (beforePersist.historySnapshots ?? []).find((h) => h.turnNumber === 1);
    check(
      'history snapshot includes DC tracks for AAR',
      Boolean(snap0 && (snap0.depthCharges?.length ?? 0) >= 1 && (snap0.units?.length ?? 0) >= 1),
      `snap=${JSON.stringify(snap0 && { turn: snap0.turnNumber, dc: snap0.depthCharges?.length, units: snap0.units?.length })}`,
    );
    for (let i = 0; i < 3; i++) {
      await api('POST', `/api/games/${dcId}/turn/lock`, {}, dcUTok);
      await api('POST', `/api/games/${dcId}/turn/resolve`, {}, dcUTok);
    }
    const afterPersistView = await api('GET', `/api/games/${dcId}/view`, undefined, dcUTok);
    const afterPersist = afterPersistView.json.view as {
      depthCharges?: Array<{ id: string; status: string }>;
      historySnapshots?: Array<{ turnNumber: number }>;
      historyTurnNumbers?: number[];
    };
    check(
      'spent DC markers persist on GT',
      spentIds.every((id) =>
        (afterPersist.depthCharges ?? []).some(
          (c) => c.id === id && (c.status === 'spent' || c.status === 'detonated'),
        ),
      ),
      `missing ${spentIds.filter((id) => !(afterPersist.depthCharges ?? []).some((c) => c.id === id)).join(',')}`,
    );
    check(
      'AAR history snapshots accumulate',
      (afterPersist.historySnapshots?.length ?? 0) >= 4 &&
        (afterPersist.historyTurnNumbers?.length ?? 0) >= 4,
      `snaps=${afterPersist.historySnapshots?.length} turns=${afterPersist.historyTurnNumbers?.length}`,
    );

    check(
      'umpire combat log has entries',
      Array.isArray(umpireFull.combatLog) && (umpireFull.combatLog?.length ?? 0) > 0,
    );

    await api('DELETE', `/api/saves/${dcId}`);

    // Dedicated DC reload-completion / rearm game (keeps audio game's detonations intact).
    {
      const reloadGame = await api('POST', '/api/games', {
        scenarioId: 'depth-charge-audio-test',
        name: 'Verify DC Reload',
      });
      check('dc reload game create', reloadGame.status === 200);
      const reloadId = String(reloadGame.json.gameId);
      const reloadUmp = await api('POST', `/api/games/${reloadId}/auth/umpire`, {
        password: 'umpire',
      });
      const reloadUTok = String(reloadUmp.json.token);
      const reloadDd = await api('POST', `/api/games/${reloadId}/auth/vessel`, {
        accessToken: 'porter-demo',
        password: 'blue',
        stationId: 'controls',
      });
      const reloadTok = String(reloadDd.json.token);
      await api(
        'POST',
        `/api/games/${reloadId}/orders`,
        { dropDepthCharges: { pattern: 'single', depthSettingM: 50 } },
        reloadTok,
      );
      await api('POST', `/api/games/${reloadId}/turn/lock`, {}, reloadUTok);
      await api('POST', `/api/games/${reloadId}/turn/resolve`, {}, reloadUTok);
      await api('POST', `/api/games/${reloadId}/depth-charge-reload`, {}, reloadTok);
      for (let i = 0; i < 5; i++) {
        await api('POST', `/api/games/${reloadId}/turn/lock`, {}, reloadUTok);
        await api('POST', `/api/games/${reloadId}/turn/resolve`, {}, reloadUTok);
      }
      const afterDcReload = await api('GET', `/api/games/${reloadId}/view`, undefined, reloadTok);
      const afterRack = (afterDcReload.json.view as {
        unit?: { depthChargeAwaitingReload?: boolean; depthChargeLoad?: number };
      }).unit;
      check(
        'DC reload completes after 5 turns',
        afterRack?.depthChargeAwaitingReload === false && afterRack?.depthChargeLoad === 23,
        `load=${afterRack?.depthChargeLoad} awaiting=${afterRack?.depthChargeAwaitingReload}`,
      );
      const dcRearm = await api(
        'POST',
        `/api/games/${reloadId}/units/dd-101/rearm`,
        {},
        reloadUTok,
      );
      check('umpire rearm DC rack', dcRearm.status === 200);
      check(
        'DC rearm restores 24',
        (dcRearm.json as { depthChargeLoad?: number }).depthChargeLoad === 24,
      );
      await api('DELETE', `/api/saves/${reloadId}`);
    }
  }

  // Aircraft attack runs (umpire intercept / bombing) — order + resolve outcome
  {
    const airGame = await api('POST', '/api/games', {
      scenarioId: 'cavalla-shokaku-philippine-sea',
      name: 'Verify Aircraft Attack Run',
    });
    check('aircraft-attack scenario create', airGame.status === 200);
    const airId = String(airGame.json.gameId);
    const airUmp = await api('POST', `/api/games/${airId}/auth/umpire`, {
      password: 'umpire',
    });
    const airTok = String(airUmp.json.token);

    // Place Zeke CAP on top of Urakaze so CPA is a close pass this turn.
    const place = await api(
      'PATCH',
      `/api/games/${airId}/units/ac-zeke-cap`,
      {
        position: { lat: 11.85, lon: 137.52, depth: 0 },
        heading: 135,
        orderedCourse: 135,
        speed: 305,
        eot: 'ahead_flank',
      },
      airTok,
    );
    check('place zeke on urakaze', place.status === 200);

    const placeDd = await api(
      'PATCH',
      `/api/games/${airId}/units/dd-urakaze`,
      {
        position: { lat: 11.85, lon: 137.52, depth: 0 },
        heading: 135,
        orderedCourse: 135,
        speed: 0,
        eot: 'stop',
        health: 100,
      },
      airTok,
    );
    check('park urakaze under zeke', placeDd.status === 200);

    const orderIntercept = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftAttack: { mode: 'intercept', targetUnitId: 'dd-urakaze' } },
      airTok,
    );
    check('queue zeke intercept order', orderIntercept.status === 200);
    const pendingOrders = (orderIntercept.json as { orders?: { aircraftAttack?: { mode?: string; targetUnitId?: string }; eot?: string } })
      .orders;
    check(
      'intercept order pending on unit',
      pendingOrders?.aircraftAttack?.mode === 'intercept' &&
        pendingOrders?.aircraftAttack?.targetUnitId === 'dd-urakaze',
    );
    check(
      'intercept auto-rings full band',
      pendingOrders?.eot === 'ahead_flank',
    );

    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    const airResolve = await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    check('resolve aircraft intercept turn', airResolve.status === 200);

    const airView = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const airCombat = (airView.json.view as {
      combatLog?: Array<{ kind?: string; summary?: string; damage?: number; targetUnitId?: string }>;
      units?: Array<{ id: string; health?: number; orders?: { aircraftAttack?: unknown } }>;
    });
    const log = airCombat.combatLog ?? [];
    check(
      'combat log has aircraft_attack run',
      log.some((e) => e.kind === 'aircraft_attack' && (e.summary ?? '').includes('intercept')),
    );
    const hitOrMiss = log.some(
      (e) => e.kind === 'aircraft_attack_damage' || e.kind === 'aircraft_attack_miss',
    );
    check('combat log has aircraft attack outcome', hitOrMiss);
    const zekeAfter = airCombat.units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'aircraft attack order cleared after resolve',
      !zekeAfter?.orders?.aircraftAttack,
    );

    // Far miss: park bomber far from Cavalla → out-of-reach miss.
    await api(
      'PATCH',
      `/api/games/${airId}/units/ac-zeke-cap`,
      {
        type: 'Aircraft',
        class: 'Bomber',
        classId: 'avenger-bomber',
        position: { lat: 11.0, lon: 136.5, depth: 0 },
        heading: 45,
        orderedCourse: 45,
        speed: 250,
        eot: 'ahead_flank',
      },
      airTok,
    );
    await api(
      'PATCH',
      `/api/games/${airId}/units/ss-cavalla`,
      {
        position: { lat: 12.5, lon: 138.5, depth: 18 },
        health: 100,
      },
      airTok,
    );
    const bombOrder = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftAttack: { mode: 'bombing_run', targetUnitId: 'ss-cavalla' } },
      airTok,
    );
    check('queue bombing run order', bombOrder.status === 200);
    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    const bombResolve = await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    check('resolve bombing run turn', bombResolve.status === 200);
    const bombView = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const bombLog =
      (bombView.json.view as { combatLog?: Array<{ kind?: string; summary?: string }> })
        .combatLog ?? [];
    check(
      'combat log has bombing run line',
      bombLog.some(
        (e) => e.kind === 'aircraft_attack' && (e.summary ?? '').includes('bombing run'),
      ),
    );
    check(
      'bombing far geometry yields miss outcome',
      bombLog.some(
        (e) =>
          e.kind === 'aircraft_attack_miss' &&
          ((e.summary ?? '').includes('out of reach') ||
            (e.summary ?? '').includes('near miss') ||
            (e.summary ?? '').includes('too deep')),
      ),
    );

    // Far miss does not consume the bomb — still have load for a close drop next.
    const afterFar = (
      bombView.json.view as {
        units?: Array<{ id: string; bombLoad?: number }>;
      }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'far-miss bombing keeps bomb load',
      (afterFar?.bombLoad ?? 0) === 1,
      `bombLoad=${afterFar?.bombLoad}`,
    );

    // Close bombing: consume ammo + emit aircraft_bomb detonation cue.
    await api(
      'PATCH',
      `/api/games/${airId}/units/ac-zeke-cap`,
      {
        type: 'Aircraft',
        class: 'Bomber',
        classId: 'avenger-bomber',
        position: { lat: 11.9, lon: 137.55, depth: 0 },
        heading: 90,
        orderedCourse: 90,
        speed: 250,
        eot: 'ahead_flank',
      },
      airTok,
    );
    await api(
      'PATCH',
      `/api/games/${airId}/units/dd-urakaze`,
      {
        position: { lat: 11.9, lon: 137.55, depth: 0 },
        heading: 90,
        orderedCourse: 90,
        speed: 0,
        eot: 'stop',
        health: 100,
      },
      airTok,
    );
    const closeBomb = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftAttack: { mode: 'bombing_run', targetUnitId: 'dd-urakaze' } },
      airTok,
    );
    check('queue close bombing run', closeBomb.status === 200);
    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    const closeBombResolve = await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    check('resolve close bombing run', closeBombResolve.status === 200);
    const closeBombView = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const closeBombUv = closeBombView.json.view as {
      recentDetonations?: Array<{ kind?: string; targetUnitId?: string }>;
      units?: Array<{ id: string; bombLoad?: number }>;
      combatLog?: Array<{ kind?: string; summary?: string }>;
    };
    const zekeSpent = closeBombUv.units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'bombing drop consumes bomb load',
      (zekeSpent?.bombLoad ?? -1) === 0,
      `bombLoad=${zekeSpent?.bombLoad}`,
    );
    check(
      'bombing emit aircraft_bomb detonation',
      (closeBombUv.recentDetonations ?? []).some(
        (d) => d.kind === 'aircraft_bomb' && d.targetUnitId === 'dd-urakaze',
      ),
    );

    // Ammo gate: cannot queue another bombing run until rearm.
    const emptyBomb = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftAttack: { mode: 'bombing_run', targetUnitId: 'dd-urakaze' } },
      airTok,
    );
    check('empty bomb load rejects bombing order', emptyBomb.status === 400);

    // Strafe still works with empty bomb rack (guns).
    const strafeOrder = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftAttack: { mode: 'strafe', targetUnitId: 'dd-urakaze' } },
      airTok,
    );
    check('strafe allowed with empty bomb rack', strafeOrder.status === 200);
    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    const strafeResolve = await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    check('resolve strafe turn', strafeResolve.status === 200);
    const strafeView = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const strafeLog =
      (strafeView.json.view as { combatLog?: Array<{ kind?: string; summary?: string }> })
        .combatLog ?? [];
    check(
      'combat log has strafe run',
      strafeLog.some(
        (e) => e.kind === 'aircraft_attack' && (e.summary ?? '').includes('strafe'),
      ),
    );
    const afterStrafe = (
      strafeView.json.view as { units?: Array<{ id: string; bombLoad?: number }> }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'strafe does not consume bomb',
      (afterStrafe?.bombLoad ?? -1) === 0,
      `bombLoad=${afterStrafe?.bombLoad}`,
    );

    // Umpire rearm restores bomb.
    const rearm = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/rearm`,
      {},
      airTok,
    );
    check('umpire rearm aircraft bombs', rearm.status === 200);
    const rearmedView = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const rearmedZeke = (
      rearmedView.json.view as { units?: Array<{ id: string; bombLoad?: number }> }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check('rearm restores bomb load', (rearmedZeke?.bombLoad ?? 0) === 1);

    // Loiter standing order persists across turns.
    const loiterStart = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftLoiter: { centerUnitId: 'cv-shokaku' } },
      airTok,
    );
    check('queue loiter over shokaku', loiterStart.status === 200);
    const loiterPending = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const loiterUnit = (
      loiterPending.json.view as {
        units?: Array<{
          id: string;
          aircraftLoiter?: { centerUnitId?: string; radiusM?: number };
          orderedCourse?: number;
        }>;
      }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'loiter state on unit',
      loiterUnit?.aircraftLoiter?.centerUnitId === 'cv-shokaku',
    );
    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    await api('POST', `/api/games/${airId}/turn/lock`, {}, airTok);
    await api('POST', `/api/games/${airId}/turn/resolve`, {}, airTok);
    const loiterAfter = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const loiterUnit2 = (
      loiterAfter.json.view as {
        units?: Array<{
          id: string;
          aircraftLoiter?: { centerUnitId?: string };
          orderedCourse?: number;
        }>;
      }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check(
      'loiter persists across turns',
      loiterUnit2?.aircraftLoiter?.centerUnitId === 'cv-shokaku',
    );
    const cancelLoiter = await api(
      'POST',
      `/api/games/${airId}/units/ac-zeke-cap/orders`,
      { aircraftLoiter: null },
      airTok,
    );
    check('cancel loiter', cancelLoiter.status === 200);
    const loiterCleared = await api('GET', `/api/games/${airId}/view`, undefined, airTok);
    const loiterUnit3 = (
      loiterCleared.json.view as {
        units?: Array<{ id: string; aircraftLoiter?: unknown }>;
      }
    ).units?.find((u) => u.id === 'ac-zeke-cap');
    check('loiter cleared', !loiterUnit3?.aircraftLoiter);

    // Hydrophone still blind to aircraft after attack resolve.
    const ssAuth = await api('POST', `/api/games/${airId}/auth/vessel`, {
      accessToken: 'cavalla-demo',
      password: 'blue',
      stationId: 'sensors',
    });
    check('cavalla sensors auth after air attack', ssAuth.status === 200);
    const ssTok = String(ssAuth.json.token);
    const hydroView = await api('GET', `/api/games/${airId}/view`, undefined, ssTok);
    const hydroPic = hydroView.json.view as {
      hydrophoneContacts?: Array<{ kind?: string }>;
    };
    check(
      'hydrophone still skips aircraft after attack runs',
      Array.isArray(hydroPic.hydrophoneContacts) &&
        (hydroPic.hydrophoneContacts ?? []).every((c) => c.kind !== undefined),
    );

    await api('DELETE', `/api/saves/${airId}`);
  }

  // --- Deck gun: destroyer + fleet-sub fire + resolve ---
  {
    const gunGame = await api('POST', '/api/games', {
      scenarioId: 'torpedo-fire-test',
      name: 'Verify Deck Gun',
    });
    check('deck-gun scenario create', gunGame.status === 200);
    const gunId = String(gunGame.json.gameId);
    const gunUmp = await api('POST', `/api/games/${gunId}/auth/umpire`, { password: 'umpire' });
    const gunUTok = String(gunUmp.json.token);
    const gunDd = await api('POST', `/api/games/${gunId}/auth/vessel`, {
      accessToken: 'porter-demo',
      password: 'blue',
      stationId: 'controls',
    });
    check('deck-gun porter controls', gunDd.status === 200);
    const gunDdTok = String(gunDd.json.token);
    const gunSub = await api('POST', `/api/games/${gunId}/auth/vessel`, {
      accessToken: 'gato-demo',
      password: 'red',
      stationId: 'controls',
    });
    check('deck-gun gato controls', gunSub.status === 200);
    const gunSubTok = String(gunSub.json.token);

    const ddMag = await api('GET', `/api/games/${gunId}/view`, undefined, gunDdTok);
    const ddUnit = (ddMag.json.view as { unit?: { deckGunLoad?: number } }).unit;
    check(
      'destroyer starts with 40 deck-gun shells',
      ddUnit?.deckGunLoad === 40,
      `load=${ddUnit?.deckGunLoad}`,
    );
    const subMag = await api('GET', `/api/games/${gunId}/view`, undefined, gunSubTok);
    const subUnit0 = (subMag.json.view as {
      unit?: { deckGunLoad?: number; position?: { depth?: number } };
    }).unit;
    check(
      'fleet sub starts with 20 deck-gun shells',
      subUnit0?.deckGunLoad === 20,
      `load=${subUnit0?.deckGunLoad}`,
    );

    const blockedSub = await api(
      'POST',
      `/api/games/${gunId}/orders`,
      {
        fireDeckGun: {
          aimHeading: 0,
          estimatedCourse: 90,
          estimatedSpeedKn: 14,
          estimatedRangeNm: 1.5,
        },
      },
      gunSubTok,
    );
    check(
      'submerged sub cannot queue deck gun',
      blockedSub.status === 400,
      `status=${blockedSub.status}`,
    );

    // Surface Gato for a playable deck-gun shot vs eastbound Porter.
    // Unit PATCH ignores eot — set speed via PATCH, then stop bells via orders
    // so kinematics do not walk either hull off the entered solution.
    await api(
      'PATCH',
      `/api/games/${gunId}/units/ss-212`,
      { position: { depth: 0 }, orderedDepth: 0, speed: 0 },
      gunUTok,
    );
    await api(
      'PATCH',
      `/api/games/${gunId}/units/dd-101`,
      { speed: 0 },
      gunUTok,
    );
    await api('POST', `/api/games/${gunId}/orders`, { eot: 'stop' }, gunSubTok);
    await api('POST', `/api/games/${gunId}/orders`, { eot: 'stop' }, gunDdTok);

    const gunView = await api('GET', `/api/games/${gunId}/view`, undefined, gunUTok);
    const gunUnits = (gunView.json.view as {
      units: Array<{
        id: string;
        position: { lat: number; lon: number; depth: number };
        heading: number;
        speed: number;
      }>;
    }).units;
    const porter = gunUnits.find((u) => u.id === 'dd-101')!;
    const gato = gunUnits.find((u) => u.id === 'ss-212')!;
    const { bearingRangeNm } = await import('@war-patrol/shared');
    const los = bearingRangeNm(gato.position, porter.position);
    const subFire = await api(
      'POST',
      `/api/games/${gunId}/orders`,
      {
        eot: 'stop',
        fireDeckGun: {
          aimHeading: los.bearing,
          estimatedCourse: porter.heading,
          estimatedSpeedKn: porter.speed,
          estimatedRangeNm: Math.round(los.rangeNm * 100) / 100,
        },
      },
      gunSubTok,
    );
    check('surfaced sub queues deck-gun fire', subFire.status === 200, `status=${subFire.status}`);

    await api('POST', `/api/games/${gunId}/turn/lock`, {}, gunUTok);
    const gunRes = await api('POST', `/api/games/${gunId}/turn/resolve`, {}, gunUTok);
    check('resolve deck-gun turn', gunRes.status === 200);

    const afterGun = await api('GET', `/api/games/${gunId}/view`, undefined, gunUTok);
    const afterView = afterGun.json.view as {
      combatLog?: Array<{ kind: string; summary: string; damage?: number }>;
      units: Array<{ id: string; health: number; deckGunLoad?: number; deckGunAwaitingReload?: boolean }>;
    };
    const gunLog = afterView.combatLog ?? [];
    check(
      'combat log has deck_gun_fire',
      gunLog.some((e) => e.kind === 'deck_gun_fire'),
      `log=${JSON.stringify(gunLog.filter((e) => String(e.kind).startsWith('deck_gun')))}`,
    );
    check(
      'surfaced sub deck gun hits Porter',
      gunLog.some((e) => e.kind === 'deck_gun_hit' && (e.summary ?? '').includes('Porter')),
      `log=${JSON.stringify(gunLog.filter((e) => e.kind.startsWith('deck_gun')))}`,
    );
    const gatoAfter = afterView.units.find((u) => u.id === 'ss-212');
    check(
      'sub deck-gun ammo consumed',
      gatoAfter?.deckGunLoad === 19 && gatoAfter?.deckGunAwaitingReload === true,
      `load=${gatoAfter?.deckGunLoad} awaiting=${gatoAfter?.deckGunAwaitingReload}`,
    );
    const porterAfter = afterView.units.find((u) => u.id === 'dd-101');
    check(
      'Porter took deck-gun damage',
      (porterAfter?.health ?? 100) < 100,
      `health=${porterAfter?.health}`,
    );

    const gunReload = await api('POST', `/api/games/${gunId}/deck-gun-reload`, {}, gunSubTok);
    check('start deck-gun reload', gunReload.status === 200);
    check(
      'deck-gun reload countdown 2',
      (gunReload.json as { deckGunReloadTurnsRemaining?: number }).deckGunReloadTurnsRemaining === 2,
    );

    // Destroyer fire vs submerged contact → miss (no useful surface engagement).
    await api(
      'PATCH',
      `/api/games/${gunId}/units/ss-212`,
      { position: { depth: 40 }, orderedDepth: 40 },
      gunUTok,
    );
    // Clear awaiting so DD can fire (rearm umpire).
    await api('POST', `/api/games/${gunId}/units/dd-101/rearm`, {}, gunUTok);
    const ddView2 = await api('GET', `/api/games/${gunId}/view`, undefined, gunUTok);
    const units2 = (ddView2.json.view as {
      units: Array<{
        id: string;
        position: { lat: number; lon: number; depth: number };
        heading: number;
        speed: number;
      }>;
    }).units;
    const porter2 = units2.find((u) => u.id === 'dd-101')!;
    const gato2 = units2.find((u) => u.id === 'ss-212')!;
    const los2 = bearingRangeNm(porter2.position, gato2.position);
    const ddFire = await api(
      'POST',
      `/api/games/${gunId}/orders`,
      {
        fireDeckGun: {
          aimHeading: los2.bearing,
          estimatedCourse: gato2.heading,
          estimatedSpeedKn: gato2.speed,
          estimatedRangeNm: Math.round(los2.rangeNm * 100) / 100,
        },
      },
      gunDdTok,
    );
    check('destroyer queues deck-gun fire', ddFire.status === 200);
    await api('POST', `/api/games/${gunId}/turn/lock`, {}, gunUTok);
    await api('POST', `/api/games/${gunId}/turn/resolve`, {}, gunUTok);
    const missView = await api('GET', `/api/games/${gunId}/view`, undefined, gunUTok);
    const missLog = (missView.json.view as { combatLog?: Array<{ kind: string; summary: string }> })
      .combatLog ?? [];
    check(
      'DD deck gun misses submerged sub',
      missLog.some(
        (e) =>
          e.kind === 'deck_gun_miss' &&
          (e.summary ?? '').includes('Porter') &&
          ((e.summary ?? '').includes('MISS') || (e.summary ?? '').includes('no surface')),
      ),
      `log=${JSON.stringify(missLog.filter((e) => e.kind.startsWith('deck_gun')).slice(-3))}`,
    );

    // Kagerō also gets the destroyer magazine.
    const kagGame = await api('POST', '/api/games', {
      scenarioId: 'kagero-destroyer-lookout-test',
      name: 'Verify Kagero Deck Gun',
    });
    check('kagero deck-gun scenario create', kagGame.status === 200);
    const kagId = String(kagGame.json.gameId);
    const kagAuth = await api('POST', `/api/games/${kagId}/auth/vessel`, {
      accessToken: 'kagero-demo',
      password: 'red',
      stationId: 'controls',
    });
    if (kagAuth.status !== 200) {
      // Token may differ — try umpire view instead.
      const kagUmp = await api('POST', `/api/games/${kagId}/auth/umpire`, { password: 'umpire' });
      const kagUTok = String(kagUmp.json.token);
      const kagView = await api('GET', `/api/games/${kagId}/view`, undefined, kagUTok);
      const kagDd = (
        (kagView.json.view as { units: Array<{ class?: string; deckGunLoad?: number }> }).units ?? []
      ).find((u) => u.class === 'Destroyer');
      check(
        'Kagerō destroyer has deck-gun magazine',
        kagDd?.deckGunLoad === 40,
        `load=${kagDd?.deckGunLoad}`,
      );
    } else {
      const kagView = await api('GET', `/api/games/${kagId}/view`, undefined, String(kagAuth.json.token));
      const kagUnit = (kagView.json.view as { unit?: { deckGunLoad?: number } }).unit;
      check(
        'Kagerō destroyer has deck-gun magazine',
        kagUnit?.deckGunLoad === 40,
        `load=${kagUnit?.deckGunLoad}`,
      );
    }
    await api('DELETE', `/api/saves/${kagId}`);
    await api('DELETE', `/api/saves/${gunId}`);
  }

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
