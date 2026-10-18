#!/usr/bin/env node
/**
 * `pnpm host` — one command to build the same-origin production bundle and
 * start the server in internet-hosting mode (`WAR_PATROL_INTERNET=1`), which
 * auto-generates/persists an admin token and prints join-ready URLs. See
 * docs/internet-hosting.md for the full path.
 *
 * By default also starts a cloudflared quick tunnel (`WAR_PATROL_TUNNEL=
 * cloudflared`) so umpire Copy can advertise `https://….trycloudflare.com`
 * station links. Opt out with `WAR_PATROL_TUNNEL=0 pnpm host` (or false/off)
 * when you already have a reverse proxy / `WAR_PATROL_PUBLIC_URL`.
 *
 * Pure LAN play (`pnpm dev` / `pnpm start`) is untouched by this script.
 */
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: isWindows });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('[war-patrol] Building shared -> client -> server (same-origin bundle)...');
run('pnpm', ['build']);

const tunnelEnv =
  process.env.WAR_PATROL_TUNNEL !== undefined && process.env.WAR_PATROL_TUNNEL !== ''
    ? process.env.WAR_PATROL_TUNNEL
    : 'cloudflared';

console.log('[war-patrol] Starting server with WAR_PATROL_INTERNET=1 ...');
if (tunnelEnv === 'cloudflared' || tunnelEnv === '1' || tunnelEnv === 'true') {
  console.log('[war-patrol] Quick tunnel: WAR_PATROL_TUNNEL=' + tunnelEnv);
} else {
  console.log(
    `[war-patrol] Quick tunnel skipped (WAR_PATROL_TUNNEL=${tunnelEnv}). Set WAR_PATROL_PUBLIC_URL or use your own HTTPS front.`,
  );
}

const child = spawn('pnpm', ['start'], {
  stdio: 'inherit',
  shell: isWindows,
  env: {
    ...process.env,
    WAR_PATROL_INTERNET: process.env.WAR_PATROL_INTERNET ?? '1',
    WAR_PATROL_TUNNEL: tunnelEnv,
  },
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
