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

Runs create → join → orders → lock → resolve (SSE) → save/rollback checks.

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
