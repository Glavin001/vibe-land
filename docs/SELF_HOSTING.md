# Self-hosting vibe-land

This repo is also set up for Vercel (see `vercel.json`), but you can host
the whole thing on your own VPS. Three processes, one nginx.

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │               nginx :443                   │
                    └──────┬───────────────┬─────────────────────┘
                           │               │
                  /api/*   │     /         │  /session-config, /healthz, /ws/*
                           │   /assets/*   │
                           ▼               ▼
                ┌──────────────────┐  ┌──────────────────┐
                │ Node API :3000   │  │ Rust server :4001│
                │ npm run api:start│  │ cargo run --rel. │
                │ api/server.ts    │  │ (TCP / WS)       │
                └──────────────────┘  └──────────────────┘
                                              │
                                              │  UDP/QUIC, bypasses nginx
                                              ▼
                                      ┌──────────────────┐
                                      │ WebTransport :4002│ (exposed directly)
                                      └──────────────────┘

                  Static files served directly by nginx from client/dist
```

The API server is a thin wrapper (`api/server.ts`) that imports every
handler in `api/worlds/*` and mounts it at the same URL Vercel would.
`/api/worlds/publish`, `/api/worlds`, `/api/worlds/:id`, `/api/worlds/:id/upload`,
etc. all work identically — it is the literal equivalent of `next start`
for this project's API folder.

## One-time setup on the box

1. **Install toolchain**: Node 20+, Rust stable, nginx, certbot.
2. **Clone the repo** to `/var/www/vibe-land` and create a `vibe-land`
   system user that owns it.
3. **Populate environment files** in `/etc/vibe-land/`:
   - `api.env` — at minimum `API_PORT=3000`, `API_HOST=127.0.0.1`, plus
     either `WORLDS_STORAGE_DIR=/var/lib/vibe-land-worlds` or the `R2_*`
     variables (see `.env.example`).
   - `server.env` — `BIND_ADDR=0.0.0.0:4001`, `WT_BIND_ADDR=0.0.0.0:4002`,
     `WT_PUBLIC_URL=https://YOUR_DOMAIN:4002`, `WT_CERT_PEM` and
     `WT_KEY_PEM` pointing at the Let's Encrypt files.
4. **Issue TLS cert**:
   ```
   sudo certbot certonly --webroot -w /var/www/certbot -d YOUR_DOMAIN
   ```
5. **Install systemd units**:
   ```
   sudo cp infra/systemd/vibe-land-api.service    /etc/systemd/system/
   sudo cp infra/systemd/vibe-land-server.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
6. **Install nginx config**:
   ```
   sudo cp infra/nginx/vibe-land.conf /etc/nginx/sites-available/vibe-land
   sudo sed -i 's/YOUR_DOMAIN/your.actual.domain/g' /etc/nginx/sites-available/vibe-land
   sudo ln -sf /etc/nginx/sites-available/vibe-land /etc/nginx/sites-enabled/vibe-land
   sudo nginx -t && sudo systemctl reload nginx
   ```
7. **Open firewall ports**: TCP 80, TCP 443, UDP 4002 (WebTransport).

## Building + deploying

Run these on the server (or build locally and rsync `client/dist` +
`target/release/server` over):

```
cd /var/www/vibe-land

# Install root deps (pulls in tsx for the API server)
npm install

# Build the static SPA into client/dist/
npm run build:client

# Build the Rust game server (release mode)
cargo build --release -p server

# Start / restart services
sudo systemctl enable --now vibe-land-api vibe-land-server
sudo systemctl restart vibe-land-api vibe-land-server
```

Subsequent deploys: `git pull && npm run build:client && cargo build
--release -p server && sudo systemctl restart vibe-land-api
vibe-land-server`. The SPA is static files — no API restart needed when
only the client changes.

## Local preview of the self-hosted stack

You don't need nginx to test the Node API layer — just:

```
npm install
npm run api:dev    # API on http://127.0.0.1:3000
npm run --prefix client dev    # Vite on :5555 with its dev proxy
make server        # Rust on :4001
```

The Vite dev proxy handles `/ws`, `/session-config`, `/healthz` already;
Vite doesn't proxy `/api/*` by default, so for end-to-end testing of
publish/gallery locally either build the SPA (`npm run build:client`) and
serve `client/dist` through nginx, or run `vercel dev` (the original
Vercel path — still supported).

## Gotchas

- **WebTransport cannot go through nginx.** It's QUIC over UDP; nginx
  only proxies HTTP/1.1, HTTP/2, and TCP streams. Expose :4002 directly
  and make sure `WT_PUBLIC_URL` in `server.env` matches the public
  hostname + port the browser will hit. The cert the Rust server loads
  must be trusted by the browser (Let's Encrypt works; self-signed only
  works in dev with the cert-hash pin flow).
- **`client_max_body_size`** in nginx must be ≥ the largest publish body
  (5 MB world + overhead). The file sets it to 8m.
- **R2 CORS**: if you use R2 for world storage, set the CORS policy from
  `.env.example`. The browser PUTs directly to the presigned URL; if CORS
  is wrong you'll see `No 'Access-Control-Allow-Origin' header` in the
  console even though the API itself is fine.
- **The API server runs TypeScript via `tsx`** in production. This is
  intentional — it keeps `api/worlds/*` identical to the Vercel-deployed
  copy with zero build step. If you'd rather ship compiled JS, add a
  `tsc` build and point `ExecStart` at the compiled `server.js`; nothing
  else needs to change.
