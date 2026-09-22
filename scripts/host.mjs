#!/usr/bin/env node
/**
 * `pnpm host` — one command to build the same-origin production bundle and
 * start the server in internet-hosting mode (`WAR_PATROL_INTERNET=1`), which
 * auto-generates/persists an admin token and prints join-ready URLs. See
 * docs/internet-hosting.md for the full path, including an optional
 * one-command cloudflared tunnel (`WAR_PATROL_TUNNEL=cloudflared pnpm host`).
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

console.log('[war-patrol] Starting server with WAR_PATROL_INTERNET=1 ...');
const child = spawn('pnpm', ['start'], {
  stdio: 'inherit',
  shell: isWindows,
  env: { ...process.env, WAR_PATROL_INTERNET: process.env.WAR_PATROL_INTERNET ?? '1' },
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
