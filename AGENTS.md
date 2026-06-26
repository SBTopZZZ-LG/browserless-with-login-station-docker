# AGENTS.md

## Project overview

Docker-based system for authenticated web scraping. Two containers share the **same Chrome instance** via CDP:

- **`login-station`** — KasmVNC browser (user signs in via web UI) + auth-proxy (Node.js scrape API + WS proxy)
- **`browserless`** — Headless Chrome API that inherits sessions from login-station
- **`nginx-proxy`** — Reverse proxy, only used in production (`--profile ssl`)

Key insight: Chromium v120+ encrypts cookies with AES-256-GCM. Cookie extraction is impossible. Instead, both containers share the same Chrome process, so sessions are inherited automatically via CDP.

## Architecture

### Container communication

```
Browserless (:3000) --ws--> Login Station (:9224 CDP WS proxy) --> Chrome (:9222)
KasmVNC user --> Chrome (:9222) --> auth-proxy scrape API (:3100)
```

- `login-station` runs Chrome (port 9222) and auth-proxy (port 3100) as s6-overlay managed services
- auth-proxy exposes a CDP WebSocket proxy on port 9224 that rewrites Chrome's WS URLs so external clients can connect through it
- `browserless` connects to `ws://login-station:9224/` via `CONNECTION_WS_ENDPOINT`

### Auth-proxy details

- Node.js ESM app (`"type": "module"` in package.json)
- Dependencies: express, puppeteer-core, ws
- Runs as s6-rc longrun service, polls Chrome CDP for up to 90s before starting
- Executed as user `abc` (linuxserver convention) via `s6-setuidgid abc node auth-proxy.js`

## Key commands

```bash
# Local dev (no SSL)
cp .env.example .env
# Edit .env — at minimum set BROWSERLESS_TOKEN=$(openssl rand -hex 32)
docker compose build login-station
docker compose up -d

# Production (HTTPS)
# Set USE_SSL=true, DOMAIN, SSL_CERT_PATH, SSL_KEY_PATH in .env
docker compose --profile ssl up -d

# Check containers
docker ps --filter "name=browserless,login-station"
docker logs login-station --tail 50
docker logs browserless --tail 50

# Health checks
curl http://127.0.0.1:3100/health
curl -H "Authorization: Bearer $BROWSERLESS_TOKEN" http://127.0.0.1:3000/pressure

# Test scrape (POST returns JSON with html/title/finalUrl)
curl -X POST http://127.0.0.1:3100/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","waitAfter":5000}'
```

## Version and release

- **Single source of truth**: `version.txt` (format: `X.Y.Z`)
- CI reads `version.txt`, checks if tag `v<version>` exists, builds/pushes to GHCR if new
- No manual git tags needed — edit `version.txt`, push, CI handles the rest
- Docker image tags: `1.0.0`, `latest` (git tag is `v1.0.0`, `v1.0`, `v1`)
- Multi-arch build: `linux/amd64`, `linux/arm64`
- Image: `ghcr.io/<owner>/browserless-login-station:<tag>`

## Docker conventions

- Base image: `lscr.io/linuxserver/chromium:latest` (linuxserver conventions apply)
- s6-overlay service at `docker/s6-auth-proxy/` — must have `type` file (`longrun`) and `dependencies.d/` dir
- `login-station` requires `--security-opt seccomp=unconfined` and `group_add: "105"` (video group) — removing these causes blank/black KasmVNC screen
- `shm_size: 1gb` on both browserless and login-station containers
- `node_modules/` excluded from Docker build context via `.dockerignore` (npm install happens in Dockerfile)
- `.env` is never baked into images — `.dockerignore` excludes it
- `CONNECTION_WS_ENDPOINT` defaults to `ws://login-station:9224/` — override to `wss://login-station:9224/` in `.env` when using SSL/nginx

## nginx

- Templates use `envsubst` — variables like `${LOGIN_DOMAIN}` are substituted at container start
- `setup.sh` selects HTTP or HTTPS config based on `USE_SSL`
- Shared headers in `nginx/proxy-headers.conf`
- Local dev: no nginx needed. Production: `--profile ssl` starts it

## Port mapping

| Service | Container port | Host port (default) |
|---------|---------------|---------------------|
| login-station (auth-proxy + KasmVNC) | 3100 | `127.0.0.1:3100` |
| login-station (CDP WS proxy) | 9224 | `127.0.0.1:9224` |
| browserless (headless API) | 3000 | `127.0.0.1:3000` |
| nginx (production only) | 80/443 | 80/443 |

## Gotchas

- auth-proxy must wait for Chrome CDP to be ready (up to 90s) before it can serve requests — the s6 run script handles this with a curl poll loop
- "No webSocketDebuggerUrl" error means Chrome CDP isn't ready yet
- Sessions not authenticated? Make sure you signed into the site via KasmVNC (login.YOUR_DOMAIN), not the browserless API
- Feed pages (LinkedIn, Twitter/X) are heavily client-side rendered — increase `waitAfter` to 8000-12000ms and use `waitUntil: "networkidle0"`
- `PUBLIC_URL_SCHEME` env var controls auth-proxy response headers (`http` or `https`)
- No test suite, no linting, no build step for auth-proxy (just `npm install` + `node auth-proxy.js`)
- The Dockerfile installs Node.js 22 from NodeSource
