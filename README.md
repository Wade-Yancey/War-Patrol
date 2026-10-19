# War Patrol

Turn-based naval simulation with an umpire and per-station vessel clients.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/) 9+

## Dev

```bash
node scripts/dev.mjs
```

- Client: http://127.0.0.1:5173
- API: http://127.0.0.1:8787

Or manually:

```bash
pnpm install
pnpm --filter @war-patrol/shared build
pnpm dev
```

Demo passwords: umpire `umpire`, destroyer `blue`, submarine `red`.

## Production

```bash
pnpm install
pnpm build
pnpm start
```

Open http://127.0.0.1:8787

## LAN (same Wi‑Fi)

```bash
pnpm build && pnpm start
```

No tunnel / no `pnpm host`. Players use `http://<LAN-IP>:8787/...`, not `127.0.0.1`. Tip: open umpire on the LAN IP before Copy, or rewrite `127.0.0.1` → LAN IP.

Internet (off-LAN): `pnpm host` / trycloudflare — see below.

## Internet hosting

```bash
pnpm host
```

See [docs/internet-hosting.md](docs/internet-hosting.md).
