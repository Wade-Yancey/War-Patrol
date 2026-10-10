# Hosting War Patrol for internet beta testers

This is the operator guide for putting vessel stations (and the umpire view) in
front of remote testers over the internet, instead of just a LAN party. It
complements [`security-stability-audit.md`](./security-stability-audit.md),
which documents the underlying trust model and what is/isn't hardened.

## TL;DR for Wade — fastest path (one command)

This is the new short path. It favors convenience over hardening on purpose —
fine for a small trusted beta; see "Residual risk" and "What the fast path
trades away" below before a wider/public beta.

```bash
pnpm install
pnpm --filter @war-patrol/shared build
pnpm host
```

`pnpm host` builds the same-origin production bundle (client + server, so
there's no CORS to configure for gameplay traffic) and starts the server with
`WAR_PATROL_INTERNET=1`. That one env var:

- **Auto-generates an admin token** if `WAR_PATROL_ADMIN_TOKEN` isn't set
  explicitly, and **persists it** to `packages/server/data/.admin-token`
  (mode `0600`, gitignored) so it survives restarts — you don't have to
  invent or remember a token.
- **Prints it, plus ready-to-open URLs with it pre-filled**, on startup:

  ```
  Admin token (auto-generated, persisted at .../data/.admin-token):
    9426453cd4ca759904260693aff3f04fd936f6ff014f3236

  Open one of these to land already signed in as admin (skips pasting the token):
    http://127.0.0.1:8787/?admin=9426453cd4ca759904260693aff3f04fd936f6ff014f3236
    http://192.168.1.42:8787/?admin=9426453cd4ca759904260693aff3f04fd936f6ff014f3236
  ```

  Open one of those links and the landing page's **Admin token** field is
  filled in automatically (the client reads `?admin=`, saves it the same way
  as manual entry, then scrubs it from the address bar) — **no copy/pasting
  the token between shell and browser.** Create the game as usual; this
  unlocks the create/load/delete UI, otherwise `401` without it.
- Still needs a public hostname/TLS in front to actually be internet-reachable
  from testers (steps 3 below) — `WAR_PATROL_INTERNET=1` only handles the
  auth/token friction, not networking. For that, either:
  - Bring your own reverse proxy (Caddy/nginx/Cloudflare named tunnel), same
    as the manual path below, or
  - Use the optional built-in **quick tunnel** integration — no reverse proxy
    config, no DNS, no signup, one extra env var:

    ```bash
    WAR_PATROL_TUNNEL=cloudflared pnpm host
    ```

    This shells out to a `cloudflared` binary you already have on `PATH`
    (install it yourself — [Cloudflare's downloads
    page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/);
    no new npm dependency was added for this) and runs `cloudflared tunnel
    --url http://localhost:<port>`. When cloudflared allocates its random
    `https://<random>.trycloudflare.com` HTTPS URL, the server prints it
    plus a join-ready link with the admin token pre-filled. If `cloudflared`
    isn't installed, the server logs the install link and keeps running
    normally (LAN/loopback access still works) — it never crashes the
    process. **Quick tunnels have no auth of their own** — anyone with the
    URL can reach the server, same trust model as sharing an unlisted link;
    fine for a short beta window, not for standing infrastructure. There's
    no custom hostname (you get a random `trycloudflare.com` subdomain each
    run) and no guaranteed uptime SLA — good enough to get a beta test
    started in minutes, not a permanent deployment.

5. Copy the per-station join links (`/g/:gameId/v/:accessToken/s/:stationId`)
   from the umpire's **Player join URLs** panel and send them to testers.
   Testers do **not** need the admin token — those routes already require the
   per-vessel `accessToken` + optional station password, unchanged from LAN
   play.

### Host vs remote URLs (read this — avoids host RECONNECTING)

With `pnpm host` + a tunnel, **two origins** hit the same Node process:

| Who | Open which origin | Why |
|---|---|---|
| **You (host machine)** | `http://127.0.0.1:8787/…` (loopback join-ready / Open) | Same-origin SSE stays on the local server — umpire + your own Controls/Sensors tabs stay **LIVE**. |
| **Remote players** | `https://…trycloudflare.com/…` (or your `WAR_PATROL_PUBLIC_URL`) | Internet-reachable; **Copy** in Player join URLs uses this public base. |

**Do not** run your own station tabs on the public/tunnel URL on the host
machine. Opening `*.trycloudflare.com` station links locally often leaves the
red LIVE indicator stuck on **RECONNECTING** (tunnel/edge long-poll path from
the same machine), while remotes on those same links stay healthy. #232 already
clears stale session tokens after a server restart (401 → password form); that
does **not** fix the host-on-tunnel case.

What the UI does now:

- Startup / tunnel logs print a **Host UI (this machine)** loopback link and
  tell you to keep local stations on `127.0.0.1`.
- `GET /api/host-info` exposes `{ publicBaseUrl, listenPort, internetMode }`
  (no admin token). `WAR_PATROL_PUBLIC_URL` or an allocated cloudflared URL
  fills `publicBaseUrl`.
- Umpire **Copy** uses `publicBaseUrl` when set (remote-ready HTTPS links)
  even if your umpire tab is on loopback. **Open** stays on the current
  browser origin (relative SPA path) so host tabs do not jump onto the tunnel.
- If you open the **umpire** UI on a tunnel/public origin, a banner offers a
  one-click `http://127.0.0.1:<port>` equivalent. Station pages never show that
  banner (remotes share the public origin; use **Open** / loopback for host
  stations).

Optional explicit public base (named tunnel / VPS / reverse proxy):

```bash
WAR_PATROL_PUBLIC_URL=https://warpatrol.example.com WAR_PATROL_INTERNET=1 pnpm start
```

If you skip `WAR_PATROL_INTERNET`/`WAR_PATROL_ADMIN_TOKEN` entirely (plain
`pnpm dev` / `pnpm start`), the server behaves exactly as it always has for
LAN parties — nothing is weakened by default, and `pnpm host`'s extra
console output doesn't appear.

### What the fast path trades away

Compared to the manual path below, `pnpm host` (with or without
`WAR_PATROL_TUNNEL=cloudflared`) additionally:

- **Puts the admin token in a URL** (`?admin=<token>`), which can land in
  browser history, and in proxy/CDN access logs if you later put one in
  front. The client strips it from the address bar immediately after
  reading it, but it was still transmitted once. Rotate it (delete
  `packages/server/data/.admin-token` and restart) if a join-ready link
  leaks anywhere public.
- **Persists the admin token to a plaintext file on disk**
  (`data/.admin-token`) rather than requiring you to generate and remember
  one yourself. Anyone with filesystem/shell access to the host machine can
  read it — same exposure as most `.env` secrets, just automated.
- **With `WAR_PATROL_TUNNEL=cloudflared`:** exposes the server on a public,
  anyone-with-the-link `trycloudflare.com` URL with no additional auth layer
  beyond the app's own admin token — there's no IP allowlisting or login
  wall at the tunnel level the way a hand-configured reverse proxy might
  have.

None of this is new risk beyond what `WAR_PATROL_ADMIN_TOKEN` /
`WAR_PATROL_CORS_ORIGIN` already accepted in #121 — it's the same trust
model, just reached with fewer manual steps. Use the manual path below (and
your own reverse proxy + secret management) if you want the token to never
touch a URL or an auto-written file.

## Manual path (equivalent, more control)

1. Build the app once so the server serves the client same-origin (avoids CORS
entirely for the actual gameplay traffic):

```bash
pnpm install
pnpm --filter @war-patrol/shared build
pnpm build
```

2. Run the server with an admin token and bound to all interfaces (already the
   default) behind TLS:

```bash
WAR_PATROL_ADMIN_TOKEN="$(openssl rand -hex 24)" \
HOST=0.0.0.0 PORT=8787 \
pnpm start
```

3. Put a TLS-terminating reverse proxy (Caddy/nginx/Cloudflare Tunnel) in
   front of port 8787 and point a public hostname at it, e.g.
   `https://warpatrol.example.com`.

4. Open `https://warpatrol.example.com/`, expand **Admin token** on the
   landing page, and paste the same token you set in
   `WAR_PATROL_ADMIN_TOKEN`. Create the game as usual — this unlocks the
   create/load/delete UI, which is otherwise `401` without it.

5. Copy the per-station join links (`/g/:gameId/v/:accessToken/s/:stationId`)
   from the umpire's **Vessel join links** panel and send them to testers.
   Testers do **not** need the admin token — those routes already require the
   per-vessel `accessToken` + optional station password, unchanged from LAN
   play.

If you skip steps 2 and 4 (no `WAR_PATROL_ADMIN_TOKEN`), the server behaves
exactly as it always has for LAN parties — nothing is weakened by default.

## What changed to make this safe

Before this change, the audit ([`security-stability-audit.md`](./security-stability-audit.md#s2))
flagged that `POST /api/games` (create + leak join tokens), `POST
/api/saves/:id/load`, `DELETE /api/saves[/:id]`, `DELETE
/api/scenarios/:id`, and the `GET /api/saves|games|scenarios` listing routes
had **no** authentication — anyone who could reach the API on the network
could create games, wipe saves, or delete scenario files. That's an
acceptable trust model for a LAN party where everyone in the room is a known
player, but not for an API bound to the public internet.

Two opt-in, env-var-gated changes address this without touching the LAN flow:

### 1. `WAR_PATROL_ADMIN_TOKEN` — host/disk admin gate

- **Unset (default):** the routes above behave exactly as before — fully
  open, no token required. This is the "clear config switch" — nothing about
  local/LAN play changes unless you set the variable.
- **Set:** every route above requires `Authorization: Bearer <token>` (or an
  `x-admin-token: <token>` header, for convenience from curl/scripts) matching
  the configured value, or it returns `401 Admin token required`.
- Vessel/umpire gameplay routes (`orders`, `view`, `events` SSE, `turn/*`,
  `auth/umpire`, `auth/vessel`, etc.) are **unaffected** — they already use
  per-session Bearer tokens issued by `auth/umpire` / `auth/vessel`, which is
  the correct mechanism for players and was not the gap.
- `GET /api/library` (static vessel-class stubs, no secrets) is intentionally
  left open; it's read-only reference data with nothing sensitive in it.
- Client: `LandingPage.tsx` (the umpire/host's create-game screen) has a new
  collapsed **"Admin token"** field. It's stored the same way as other
  session tokens (`localStorage`/`sessionStorage`, mirrors the pattern in
  `authStorage.ts`) and sent on the admin-gated calls. Leave it blank for
  local/LAN servers.

Set the token to a long random value, e.g.:

```bash
openssl rand -hex 24
```

Do **not** reuse umpire/vessel demo passwords as the admin token — it's a
different, stronger secret that guards disk-mutating operations across every
game on the host.

### 2. `WAR_PATROL_CORS_ORIGIN` — CORS allowlist

- **Unset (default):** CORS stays `origin: true` (reflects any Origin) — same
  as before, fine for the LAN dev-server flow (Vite on `127.0.0.1:5173`
  proxying to the API) and for same-origin production hosting (client served
  by the same Fastify process — see step 1 above, which needs **no** CORS at
  all since there's no cross-origin request).
- **Set:** a comma-separated allowlist of exact origins, e.g.:

  ```bash
  WAR_PATROL_CORS_ORIGIN="https://warpatrol.example.com"
  ```

  Only listed origins receive `Access-Control-Allow-Origin`; everything else
  gets no CORS headers on cross-origin requests. Only relevant if you serve
  the client from a different origin than the API (e.g. a separate static
  host/CDN) — recommended for that setup, unnecessary if you follow the
  same-origin deploy in step 1.

### 3. `WAR_PATROL_INTERNET` / `pnpm host` / `WAR_PATROL_TUNNEL` — the fast path

Added on top of the two gates above (which do the actual security work) to
remove Wade's manual steps — generating a token, setting env vars in two
places, and pasting the token into the browser:

- `WAR_PATROL_INTERNET=1` (any of `1`/`true`/unset-other-than-`0`/`false`/`off`
  counts as "on"), read in `packages/server/src/hostInfo.ts` and applied from
  `index.ts` before the server starts listening:
  - If `WAR_PATROL_ADMIN_TOKEN` is already set, it's left alone — this var
    only fills the gap when there's no explicit token, it never overrides one.
  - Otherwise generates a `crypto.randomBytes(24)` hex token, writes it to
    `packages/server/data/.admin-token` (mode `0600`, gitignored) so restarts
    reuse the same value, and sets `process.env.WAR_PATROL_ADMIN_TOKEN` to it
    — the existing `requireAdmin()` gate in `routes/api.ts` needs no changes.
    If the disk write fails (read-only filesystem, some containers), falls
    back to a per-process token that still gets printed/wired in but won't
    survive a restart.
  - Prints the token and join-ready URLs (`http://<host>:<port>/?admin=<token>`,
    one per detected non-loopback IPv4 address plus loopback) after the
    server starts listening. **When unset, the startup log is unchanged**
    (`War Patrol server listening on http://<host>:<port>`, the same single
    line as before this change) — nothing here touches default LAN behavior.
- `pnpm host` (`scripts/host.mjs`, also aliased as `pnpm expose`): runs
  `pnpm build` then `pnpm start` with `WAR_PATROL_INTERNET=1` in the child's
  env (unless already set otherwise). Pure convenience wrapper — equivalent
  to running `pnpm build && WAR_PATROL_INTERNET=1 pnpm start` by hand.
- `WAR_PATROL_TUNNEL=cloudflared`: when set, `hostInfo.ts` spawns
  `cloudflared tunnel --url http://localhost:<port>` (the binary must already
  be on `PATH` — this repo does not depend on or bundle it), scrapes its
  stdout/stderr for the `https://<random>.trycloudflare.com` URL Cloudflare's
  free quick-tunnel service allocates, publishes that origin as
  `publicBaseUrl` for `/api/host-info` (unless `WAR_PATROL_PUBLIC_URL` is
  already set), and prints it plus a join-ready link with the admin token
  appended **and** a loopback Host UI reminder. If `cloudflared` isn't
  installed, the spawn fails with `ENOENT`, which is caught and logged (an
  install-link pointer) — the server keeps running on LAN/loopback either
  way; a missing/failed tunnel is never fatal.
- `WAR_PATROL_PUBLIC_URL`: optional explicit public origin for Copy (named
  tunnel / reverse proxy). Takes priority over the quick-tunnel scrape.
- Client (`LandingPage.tsx`): on mount, reads `?admin=<token>` from the URL
  query string, stores it exactly like manual entry (`localStorage` +
  `sessionStorage`, mirroring `authStorage.ts`), then calls
  `history.replaceState` to strip the query param from the address bar so
  the token doesn't linger visibly in the URL/bookmarks (it can still land in
  browser history and any proxy access logs from the one request that served
  the page — see Residual risk). The **Admin token** `<details>` panel now
  auto-expands when a token is present instead of staying collapsed.

### 4. Bind host / port (already existed, now documented)

`packages/server/src/index.ts` already reads:

```ts
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
```

So the server already listens on all interfaces by default — no code change
was needed here. What was missing was documentation and the auth/CORS gates
above so that binding to `0.0.0.0` and exposing it publicly is actually safe.
Set `HOST=127.0.0.1` explicitly if you only ever want loopback/reverse-proxy
access on the same machine.

## Recommended internet deployment shape

```
Internet testers
      │  HTTPS (wss not used — plain SSE over HTTPS)
      ▼
Reverse proxy (Caddy/nginx/Cloudflare Tunnel) — TLS termination
      │  HTTP, localhost or private network
      ▼
Node process: pnpm start (serves built client + API, same origin)
      │
      ▼
data/ (saves, scenarios) on local disk
```

- **TLS:** terminate at the reverse proxy, as the existing README already
  noted under "HTTPS". Browsers require HTTPS for reliable long-lived
  `fetch`/SSE from a public origin, and it protects session/access tokens
  (currently Bearer / `?token=` on SSE — see Residual risk) in transit.
- **Reverse proxy SSE settings:** disable buffering / long-lived timeouts for
  `/api/games/:gameId/events`, matching what the Vite dev proxy already does
  (`configure` block in `packages/client/vite.config.ts` sets
  `X-Accel-Buffering: no` and disables timeouts). For nginx:
  `proxy_buffering off; proxy_read_timeout 3600s;` on that location.
  The server sends SSE keepalives about every **8s** (≈1KiB padded comment +
  `event: ping`) so quiet stations (Controls between turns, LAN tablets, and
  cloudflared/quick-tunnel clients) do not look idle to the proxy or the
  browser. Padding helps intermediaries that buffer tiny writes. You still need
  buffering off / long read timeouts on that path — heartbeats alone cannot
  fix a proxy that buffers the whole stream.
- **High-RTT / UK-style SSE freeze:** Order POSTs and `GET /view` (browser
  refresh) can keep working while the long-lived `/events` stream stalls
  through a quick tunnel — the LIVE dot used to stay green on a zombie OPEN
  connection. Clients now treat **~25s without a parsed ping/state frame** as
  stale: they flip to **RECONNECTING**, force-close the stream, refetch
  `/view`, and reopen SSE (no full page refresh needed). Server-side, stuck
  write backpressure drops the fan-out client after ~45s so dead tunnels do
  not sit in the broadcast list forever. LAN and nearer remotes (e.g. STL)
  should still see a steady LIVE when pings arrive.
- **Turn timer sync:** stations count down from the shared ISO
  `turn.timerDeadline` with local wall clocks. If one remote tablet lights the
  timer a second or two after another, that is delayed SSE delivery (tunnel /
  backlog), not clock drift — once both have the same deadline they stay in
  sync. Shrinking join/leave SSE frames and avoiding GET `/view` storms on
  reconnect reduces that stagger; it cannot remove Cloudflare quick-tunnel
  RTT itself.
- **Quick-tunnel latency (irreducible):** `WAR_PATROL_TUNNEL=cloudflared`
  free quick tunnels add an extra public hop. Order clicks and SSE state
  pushes feel laggy compared with LAN even when the stream stays healthy —
  expect tens-to-hundreds of ms of extra RTT, and occasional multi-second
  stalls under load. For a smoother remote beta, prefer a named tunnel or
  a VPS reverse proxy closer to players; keep quick tunnels for "online in
  minutes" smoke tests.
- **Optics (Lookout / Periscope) on remote:** contact pick, compass REL/TRUE,
  and silhouette swaps are local-first — they must not wait on tunnel RTT.
  Fleet-sub mast UP/DOWN paints immediately; the POST is debounced. SSE view
  apply runs as a React transition so a large remote state frame does not
  block those interactions. **Still tunnel-bound:** FoW contact/sighting
  lists filling after mast raise or turn resolve (server picture must arrive),
  and any other station seeing your raised feather — local chrome cannot
  invent accurate FoW.
- **Same-origin client:** build the client into the server's static bundle
  (`pnpm build` at the repo root builds `shared` → `client` → `server`, and
  `app.ts` auto-serves `packages/client/dist` when present) so there is no
  cross-origin traffic for gameplay at all — this sidesteps CORS
  configuration for the common case.
- **Docker:** the existing `Dockerfile` already builds this same-origin
  bundle and exposes `8787`. Pass `WAR_PATROL_ADMIN_TOKEN` (and optionally
  `WAR_PATROL_CORS_ORIGIN`, `HOST`, `PORT`) as container env vars:

  ```bash
  docker build -t war-patrol .
  docker run -p 8787:8787 \
    -e WAR_PATROL_ADMIN_TOKEN="$(openssl rand -hex 24)" \
    -v war-patrol-data:/app/packages/server/data \
    war-patrol
  ```

  Mount `packages/server/data` as a volume so saves/scenarios survive
  container restarts.

## Verifying it locally before going live

```bash
# Build once
pnpm --filter @war-patrol/shared build
pnpm --filter @war-patrol/server build

# Start with an admin token and confirm host/disk routes now require it
WAR_PATROL_ADMIN_TOKEN=secret123 PORT=8799 node packages/server/dist/index.js &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/api/scenarios        # 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer secret123' http://127.0.0.1:8799/api/scenarios          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/api/health           # 200 (always open)

# Confirm the CORS allowlist rejects non-listed origins
WAR_PATROL_CORS_ORIGIN=https://warpatrol.example.com node packages/server/dist/index.js &
curl -sD - -o /dev/null http://127.0.0.1:8787/api/health -H 'Origin: http://evil.example.com' \
  | grep -i access-control   # no output = correctly rejected
curl -sD - -o /dev/null http://127.0.0.1:8787/api/health -H 'Origin: https://warpatrol.example.com' \
  | grep -i access-control   # access-control-allow-origin: https://warpatrol.example.com
```

Both env vars were exercised this way during this change, and `pnpm verify` /
`pnpm verify:stability` were run **without** either var set to confirm the
default LAN flow is byte-for-byte unchanged (all checks pass).

Fast-path (`WAR_PATROL_INTERNET`) checks run for this change:

```bash
# No token file yet — WAR_PATROL_INTERNET=1 should generate + persist one
rm -f packages/server/data/.admin-token
PORT=8799 WAR_PATROL_INTERNET=1 node packages/server/dist/index.js &
TOKEN=$(cat packages/server/data/.admin-token)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/api/scenarios                        # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8799/api/scenarios                                                                # 200
kill %1

# Restart — same file should be reused, not regenerated
PORT=8799 WAR_PATROL_INTERNET=1 node packages/server/dist/index.js &
[ "$(cat packages/server/data/.admin-token)" = "$TOKEN" ] && echo "token persisted" || echo "MISMATCH"
kill %1
```

Confirmed: default LAN mode prints the unchanged single startup line and
stays fully open; `WAR_PATROL_INTERNET=1` auto-generates/persists/reuses the
token, gates the routes, and prints the join-ready `?admin=` URLs;
`WAR_PATROL_ADMIN_TOKEN` set explicitly still takes priority over
`WAR_PATROL_INTERNET`; `pnpm host` builds then starts with the var applied;
and `WAR_PATROL_TUNNEL=cloudflared` with no `cloudflared` binary installed
logs an install pointer without crashing the server. `pnpm verify` /
`pnpm verify:stability` still pass unmodified.

## Residual risk — still worth knowing before a wide public beta

These are called out in the audit and were **not** in scope for "make
internet hosting possible" but matter for a larger/less-trusted beta:

- **Umpire view ships plaintext vessel passwords** (`buildUmpireView` sends
  `unit.password`). Anyone with the umpire session (which you'll now be
  sharing your admin token to protect, not the umpire password itself) sees
  every vessel's plaintext password. Fine for a small trusted beta group;
  redact before opening umpire access widely.
- **SSE auth token in the URL query string** (`?token=`, required because
  browser `EventSource`/`fetch`-stream can't set custom headers reliably
  across all proxies). Server-side logs already redact it
  (`redactTokenQuery`), but it can still land in proxy access logs, browser
  history, or `Referer` headers if a page embeds cross-origin assets. Keep
  HTTPS on (encrypts the query string in transit) and avoid putting
  third-party embeds on station pages.
- **Session tokens never expire** and aren't revoked on password change
  (except full `clearGame` on save load). For a short beta window this is
  low risk; for a long-running public server, consider TTLs.
- **Join/access tokens are visible to whoever created the game** via the
  `POST /api/games` response and can be rotated per-vessel
  (`rotate-token`) if a link leaks, but are otherwise stable strings — don't
  post them anywhere public beyond the intended tester.

None of these block "reachable over the internet with reasonable auth and
CORS," which was the goal here; they're the next tier if the beta grows past
a small, trusted group of testers.

### Additional tradeoffs from the fast path (`pnpm host`, `WAR_PATROL_INTERNET`, `WAR_PATROL_TUNNEL`)

These are new with this change, deliberately trading a bit more convenience
for a bit less hardening than the manual `WAR_PATROL_ADMIN_TOKEN` path — see
"What the fast path trades away" above for the summary; in full:

- **Admin token travels in a URL** (`?admin=<token>`). It's stripped from the
  visible address bar client-side after being read, but the one request that
  loaded the page still carried it, so it can land in browser history and
  (if you put a reverse proxy or CDN in front) that layer's access logs.
  Rotate the token (delete `packages/server/data/.admin-token`, restart) if a
  join-ready link is shared somewhere it shouldn't be.
- **Admin token is auto-written to a plaintext file on disk**
  (`packages/server/data/.admin-token`, `0600`, gitignored) rather than only
  living in an env var you chose and typed. Anyone with filesystem or shell
  access to the host has the same access to it that `WAR_PATROL_ADMIN_TOKEN`
  in your shell history/`.env` would already give them — not a new class of
  exposure, just automated instead of manual.
- **`WAR_PATROL_TUNNEL=cloudflared` quick tunnels have no auth of their own**
  and no custom hostname — anyone with the randomly-allocated
  `https://<random>.trycloudflare.com` URL for that run can reach the server
  (the app's own admin-token/session gates still apply on top). Good for
  getting a short beta session online in minutes; use a named tunnel or your
  own reverse proxy + DNS for anything longer-lived.

As with the rest of this doc, none of this blocks a small trusted beta; it's
what to harden first if the audience or duration grows.
