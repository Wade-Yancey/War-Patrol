# War Patrol

Hosted naval warfare simulator shell — double-blind, turn-based engagements with an umpire and per-station vessel clients.

## Phase 1 (this repo)

Hosted game shell only: create/load games, umpire + vessel auth, SSE state push, turn timer/lock/resolve stub, ground-truth umpire map, helm + EOT order entry. Sensors, weapons, detection/FoW, and audio are out of scope.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/) 9+ (via Corepack)

## Quick start

Enable pnpm with Corepack (Node 20+), then install and run:

```bash
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm --filter @war-patrol/shared build
pnpm dev
```

- Client: http://127.0.0.1:5173  
- API: http://127.0.0.1:8787  

Demo scenario passwords: umpire `umpire`, destroyer `blue`, submarine `red`.

**Porter Radar:** after creating a game, open umpire → USS Porter → **Radar**, or  
`/g/<gameId>/v/porter-demo/s/radar` (password `blue`).

**Gato Radar:** umpire → USS Gato → **Radar**, or `/g/<gameId>/v/gato-demo/s/radar` (password `red`).  
Sub PPI only when surfaced (depth ≤ 5 m); umpire **Apply depth** 40 m shows “Radar unavailable — submerged” and clears the sub as a contact on Porter’s scope.

### Production-style (API serves built client)

```bash
pnpm install
pnpm build
pnpm start
```

Open http://127.0.0.1:8787

### Verify end-to-end path

```bash
pnpm --filter @war-patrol/shared build
pnpm verify
```

Runs create → join → orders → lock → resolve (SSE) → save/rollback (with confirm) → delete save/scenario → multi-turn ground-truth stability.

Stability alone (8 turns, known orders, kinematics + radar surface rules):

```bash
pnpm verify:stability
```

Asserts positions / headings / speeds / in-game clock against an independent expected model, turn-rate caps, no NaN/teleports, and radar clear when submerged.

## Layout

```
packages/shared   # types, schema version, geo/EOT helpers
packages/server   # Fastify API, JSON file store, turn engine, SSE
packages/client   # React/Vite umpire + station UIs
```

Scenarios: `packages/server/data/scenarios/`  
Vessel class stubs: `packages/server/data/library/`  
Saves (auto after resolve): `packages/server/data/saves/`

## HTTPS

Terminate TLS at a reverse proxy in front of the Node process for public deploy.

## Hosting beyond LAN (internet-facing)

Fastest path — one command:

```bash
pnpm host
```

Builds the same-origin production bundle and starts the server with
`WAR_PATROL_INTERNET=1`, which auto-generates (and persists, so restarts
reuse it) an admin token and prints a join-ready URL with it pre-filled
(`http://<host>:<port>/?admin=<token>`) — open that link and the landing
page's admin token is already wired in, no copy/paste. See
[`docs/internet-hosting.md`](docs/internet-hosting.md) for the full walkthrough,
an optional one-command `cloudflared` tunnel, and residual-risk notes.

Manual path, same effect, explicit token:

```bash
WAR_PATROL_ADMIN_TOKEN="$(openssl rand -hex 24)" pnpm start
```

Either way, by default the server binds `0.0.0.0:8787` and would otherwise
accept host/disk admin requests (create game, load/delete saves, delete
scenarios) from anyone who can reach it — fine for a trusted LAN party, not
for the open internet, which is what the token above gates
(`Authorization: Bearer <token>` or `x-admin-token:` on the admin/disk
routes). Leave both `WAR_PATROL_INTERNET` and `WAR_PATROL_ADMIN_TOKEN` unset
(the default, `pnpm start`/`pnpm dev`) to keep the original open LAN
behavior unchanged.

Optionally set `WAR_PATROL_CORS_ORIGIN=https://your-host` (comma-separated
allowlist) to restrict cross-origin API access — unnecessary if you serve the
client from the same origin as the API (`pnpm build && pnpm start`, as
above). Put a TLS-terminating reverse proxy (Caddy/nginx/Cloudflare Tunnel)
in front for HTTPS; disable proxy buffering / long timeouts on
`/api/games/:gameId/events` (long-lived SSE).
