#!/usr/bin/env node
/**
 * One-command local bootstrap + `pnpm dev`.
 *
 * Prefer an existing `pnpm` on PATH. Corepack is only used when pnpm is
 * missing, and Corepack failures stay quiet (many Node installs ship without
 * it). Run with: `node scripts/dev.mjs` (no pnpm required to start).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageManager = typeof pkg.packageManager === 'string' ? pkg.packageManager : 'pnpm@9.15.0';
const [pmName, pmVersion = '9.15.0'] = packageManager.split('@');
const minNodeMajor = Number((String(pkg.engines?.node ?? '>=20').match(/(\d+)/) || [])[1]) || 20;

function log(msg) {
  console.log(`[war-patrol] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[war-patrol] ${msg}`);
  process.exit(code);
}

function commandExists(cmd) {
  // `command -v` is a shell builtin; always probe through a shell.
  const result = isWindows
    ? spawnSync('where', [cmd], { encoding: 'utf8', shell: true })
    : spawnSync('sh', ['-c', `command -v ${JSON.stringify(cmd)}`], { encoding: 'utf8' });
  return result.status === 0;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.stdio ?? 'inherit',
    shell: isWindows,
    cwd: root,
    env: opts.env ?? process.env,
    encoding: opts.encoding,
  });
  if (result.error) {
    if (!opts.allowFail) fail(`Failed to run ${cmd}: ${result.error.message}`);
    return result;
  }
  if (result.status !== 0 && !opts.allowFail) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < minNodeMajor) {
    fail(`Node.js ${minNodeMajor}+ required (found ${process.versions.node}).`);
  }
  log(`Node ${process.versions.node}`);
}

function ensurePnpm() {
  if (commandExists('pnpm')) {
    const ver = spawnSync('pnpm', ['--version'], {
      encoding: 'utf8',
      shell: isWindows,
      cwd: root,
    });
    const version = (ver.stdout || '').trim() || 'unknown';
    log(`Using existing pnpm ${version}`);
    return;
  }

  if (pmName !== 'pnpm') {
    fail(`package.json packageManager is ${packageManager}; this script only bootstraps pnpm.`);
  }

  if (commandExists('corepack')) {
    log(`pnpm not on PATH; trying Corepack (${packageManager})...`);
    // Quiet optional Corepack: suppress stderr/stdout from enable/prepare so
    // missing shims or policy blocks do not look like hard failures.
    run('corepack', ['enable'], {
      allowFail: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    run('corepack', ['prepare', `${pmName}@${pmVersion}`, '--activate'], {
      allowFail: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });
    if (commandExists('pnpm')) {
      log(`Activated pnpm ${pmVersion} via Corepack`);
      return;
    }
    log('Corepack did not provide pnpm; falling through to install instructions.');
  } else {
    log('Corepack not on PATH (optional); skipping.');
  }

  fail(
    [
      'pnpm is required but was not found.',
      'Install pnpm 9+ (https://pnpm.io/installation), or use a Node.js build that includes Corepack, then re-run:',
      '  node scripts/dev.mjs',
    ].join('\n'),
  );
}

assertNodeVersion();
ensurePnpm();

log('Installing workspace dependencies...');
run('pnpm', ['install']);

log('Building @war-patrol/shared...');
run('pnpm', ['--filter', '@war-patrol/shared', 'build']);

log('Starting pnpm dev (client + server)...');
const child = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  shell: isWindows,
  cwd: root,
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* best effort */
    }
  });
}
