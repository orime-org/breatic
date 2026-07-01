# Deployment Guide

Breatic supports three deployment modes:

| Mode | Use Case | App Services | Database |
|------|----------|-------------|----------|
| [Local Development](#local-development) | Writing code, debugging | Local process (tsx watch, hot reload) | Docker container |
| [Self-Hosted](#self-hosted-deployment) | Open-source users, internal deploy | Docker container | Docker container |
| [SaaS Production](#saas-production) | breatic.ai | Docker / K8s | Managed service (RDS) |

## Architecture

```
                    ┌──────────────────────────────────┐
  User Browser ───► │  Nginx (port 80/443)             │
                    │  ├── /           → Static files   │
                    │  ├── /api/*      → API (:3000)    │
                    │  ├── /ws         → Collab (:1234) │
                    │  └── /uploads/*  → API (:3000)    │
                    └──────────────────────────────────┘
                          │            │            │
                    ┌─────┴──┐  ┌──────┴──┐  ┌─────┴────┐
                    │  API   │  │ Collab   │  │  Worker  │
                    │ :3000  │  │  :1234   │  │ (no port)│
                    └────┬───┘  └────┬─────┘  └────┬─────┘
                         └───────────┼─────────────┘
                              ┌──────┴──────┐
                         ┌────┤  Redis :6379 ├────┐
                         │    └──────────────┘    │
              DB 0     DB 1    DB 2      DB 3      PG :5432
            session   BullMQ  Streams   collab
             lock      queue  (x-svc)   pub/sub
           rate-limit                   + lock
```

| Component | Description |
|-----------|-------------|
| **Nginx** | Reverse proxy + static files. Auto-detects SSL certificates at startup. |
| **API** | Hono HTTP server. Agent chat SSE, text mini-tool SSE, REST endpoints. |
| **Collab** | Hocuspocus WebSocket server. Yjs real-time sync, Redis Streams consumer. |
| **Worker** | BullMQ background processor. AIGC generation (image/video/audio/tts/3d). |
| **PostgreSQL** | Primary database (Drizzle ORM). Schema managed by explicit migration — `pnpm db:migrate` locally, `migrate` service in Docker. |
| **Redis** | 4 logical DBs: DB 0 (session/lock/rate-limit), DB 1 (BullMQ), DB 2 (cross-service Streams), DB 3 (collab cross-instance coordination — Hocuspocus pub/sub + space-delete lock). |

---

## Local Development

For writing code with hot reload. Only PostgreSQL and Redis run in Docker.

### Prerequisites

- Node.js 22+, pnpm 9+
- Docker (for PostgreSQL + Redis)

### Setup

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
pnpm install

# Start database and cache only
docker compose up -d postgres redis

# Create environment config
cp .env.dev .env
# Defaults work for local dev — edit AI provider keys as needed

# Run migrations (first time, or after pulling changes that add migrations)
pnpm db:migrate
```

### Start Services

```bash
# Start all services (turbo auto-builds shared → core first)
pnpm dev
```

This starts API (:3000), Collab (:1234), Worker, and frontend (:8000) via turbo. Or start individually:

```bash
pnpm dev:server       # API server (port 3000)
pnpm dev:collab       # Hocuspocus (port 1234)
pnpm dev:worker       # BullMQ Worker
cd packages/web && pnpm dev  # Vite frontend (port 8000)
```

> **Fail-fast startup**: If PostgreSQL or Redis is unreachable, each service exits immediately with a clear error (no silent hangs). You'll see:
> ```
> ❌ PostgreSQL not reachable: connect ECONNREFUSED
>    → Check DATABASE_URL=... or run: docker compose up -d postgres
> ```
>
> `pnpm dev` runs `turbo run dev` with `dependsOn: ["^build"]`, which auto-compiles `@breatic/shared` and `@breatic/core` before starting app services. Migration is a **separate step** (`pnpm db:migrate`) — dev mode does not auto-migrate.

### Local Dev Environment Variables

Default values in `.env.dev` work out of the box:

| Variable | Value | Note |
|----------|-------|------|
| `DATABASE_URL` | `postgres://breatic:breatic@localhost:5432/breatic` | Docker PG |
| `REDIS_URL` | `redis://localhost:6379/0` | Session, lock, rate-limit |
| `REDIS_QUEUE_URL` | `redis://localhost:6379/1` | BullMQ task queue |
| `REDIS_STREAM_URL` | `redis://localhost:6379/2` | Cross-service Streams (worker/server → collab) |
| `REDIS_COLLAB_URL` | `redis://localhost:6379/3` | Collab cross-instance coordination (Hocuspocus pub/sub + space-delete lock) |
| `ALLOWED_ORIGINS` | `http://localhost:8000` | Vite dev server (CORS, only needed if you bypass the dev proxy) |

Frontend API/WebSocket URLs are **not** in `.env` — they resolve automatically from `window.location` at runtime. Vite's dev proxy (configured in `packages/web/vite.config.ts`) forwards `/api/*` to `localhost:3000`, `/ws` to `localhost:1234`, and `/uploads/*` to `localhost:3000`, so the browser sees a single origin (`localhost:8000`) just like it would see a single origin in production (`your-domain.com` via nginx).

### Key Differences from Docker Deployment

- App code runs via `tsx watch` — changes auto-reload in seconds.
- Frontend uses Vite dev server with HMR (port 8000), not Nginx.
- Vite's dev proxy plays the role Nginx plays in production — same `/api`, `/ws`, `/uploads` routes, same single-origin model.
- Database/Redis URLs use `localhost` (not container names).

---

## Self-Hosted Deployment

One command deploys everything. For open-source users and internal networks.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2+
- A domain with DNS pointing to your server (for HTTPS)
- SSL certificate files (optional, HTTP works without)

### Quick Start

```bash
# 1. Clone (you only need docker-compose.yml + .env.docker from here)
git clone https://github.com/orime-org/breatic.git
cd breatic

# 2. Configure environment
cp .env.docker .env
# Edit .env — change these at minimum:
#   SESSION_SECRET_KEY=<random-string-min-16-chars>
#   DATABASE_URL / REDIS_URL / REDIS_QUEUE_URL / REDIS_STREAM_URL — real infra
#   Stripe / OAuth / AIGC API keys as applicable
# The frontend's API/WebSocket host is NOT configured in .env — it auto-detects
# from window.location at runtime. Same bundle works on any domain.

# 3. (Optional) Enable HTTPS — place cert files
cp /path/to/your-cert.pem docker/certs/cert.pem
cp /path/to/your-cert.key docker/certs/cert.key

# 4. Pull pre-built images and start
docker compose pull
docker compose up -d

# 5. Verify each service is reporting healthy
docker compose ps
# → STATUS column should show "Up (healthy)" for server / collab / worker
#   once start_period elapses (~30s after first start)
docker exec breatic-server-1 wget -q -O - http://localhost:3001/healthz
# → { "status": "ok", "service": "server", "checks": { "postgres": { "ok": true, ... }, "redis_general": { "ok": true, ... } } }
```

You don't need Node, pnpm, or to build anything locally — `docker compose` pulls images from GHCR (`ghcr.io/orime-org/breatic` + `ghcr.io/orime-org/breatic-web`) that CI built and published.

### Choosing an image version (`BREATIC_TAG`)

Every service in `docker-compose.yml` references `${BREATIC_TAG:-latest}`. Set `BREATIC_TAG` in your `.env` to pick which version this deployment tracks. Leave it unset to follow `:latest`.

| Value | What it tracks | Who uses it |
|-------|----------------|-------------|
| *(unset)* or `latest` | `main` branch, updated on every merge | Open-source users who want the latest stable |
| `test_thinkai_cc` | `test_thinkai_cc` branch | The thinkai.cc staging deployment |
| `1.2.3` | git tag `v1.2.3` | Production deployments pinning a specific release |
| `1.2` | latest patch of the `1.2.x` line | Production deployments tracking a minor line |

To upgrade (after CI publishes a new image):

```bash
docker compose pull
docker compose up -d --force-recreate
```

The `--force-recreate` is important — without it, compose keeps using the old image even after pulling the new one.

### GHCR package visibility (one-time setup)

The first time CI publishes images, the packages are **private by default**. For open-source users to pull without authenticating, switch them to public once:

1. Go to https://github.com/orgs/orime-org/packages
2. Click the `breatic` package → Package settings → "Change visibility" → Public
3. Repeat for `breatic-web`

From then on, anyone can `docker pull ghcr.io/orime-org/breatic:latest` without a GitHub token.

Deployments behind a firewall that want to keep images private: skip the visibility change, and have the deployment environment run `docker login ghcr.io` with a PAT (classic token, `read:packages` scope) before `docker compose pull`.

### Using external PostgreSQL / Redis (managed services)

The default `docker-compose.yml` includes `postgres` and `redis` services so a single `docker compose up -d` gives you a fully working stack. In production you'll usually want managed services (RDS / Neon / Supabase for PG, ElastiCache / Upstash / Aiven for Redis) for backups, failover, and independent scaling.

To switch to external infra, edit `docker-compose.yml` before `docker compose up`:

1. **Delete (or comment out) the `postgres` and `redis` service blocks** near the top of the file.
2. **Delete (or comment out) the `depends_on` entries that reference them** in `migrate`, `server`, `collab`, and `worker`. Compose will error if a service depends on one that doesn't exist.
3. **Point the URLs at your external hosts** in `.env`:

   ```bash
   DATABASE_URL=postgres://user:pass@your-rds-host:5432/breatic
   REDIS_URL=redis://your-redis-host:6379/0
   REDIS_QUEUE_URL=redis://your-redis-host:6379/1
   REDIS_STREAM_URL=redis://your-redis-host:6379/2
   ```

4. `docker compose up -d` — only the 5 app containers (server / worker / collab / migrate / web) come up; there is no embedded PG/Redis running unused.

This is the pattern Immich, Outline, Mattermost, and most other Compose-distributed OSS projects use. It's a one-time ~5-line edit, done once per deployment.

> Do NOT keep the `postgres` / `redis` services running and point URLs at external hosts at the same time — compose would bind `:5432` and `:6379` on the host unnecessarily, risking conflicts with existing databases. The embedded services exist only for the all-in-one convenience path.

### HTTPS (SSL)

The Nginx container auto-detects SSL certificates at startup:

- **Certificates found** (`docker/certs/cert.pem` + `cert.key`): HTTPS enabled, HTTP → HTTPS redirect.
- **No certificates**: HTTP only (port 80).

No config changes needed — just place the cert files and restart:

```bash
cp your-domain.pem docker/certs/cert.pem
cp your-domain.key docker/certs/cert.key
docker compose restart web
```

> Certificate files in `docker/certs/` are git-ignored and will not be committed.

### Environment Variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SESSION_SECRET_KEY` | Session signing key (random string, min 16 chars) | `my-super-secret-key-2026` |

> The frontend has no `VITE_API_URL` / `VITE_WS_URL` / `VITE_BASE_URL` — API and WebSocket URLs resolve from `window.location` at runtime, so one bundle works on any host behind a single reverse proxy. See the [Canonical domain](#canonical-domain) section for why same-origin matters.

#### Database & Redis (defaults work for Docker)

| Variable | Default | Note |
|----------|---------|------|
| `DATABASE_URL` | `postgres://breatic:breatic@postgres:5432/breatic` | Use container name `postgres` |
| `REDIS_URL` | `redis://redis:6379/0` | Session, lock, rate-limit |
| `REDIS_QUEUE_URL` | `redis://redis:6379/1` | BullMQ task queue |
| `REDIS_STREAM_URL` | `redis://redis:6379/2` | Streams + Hocuspocus pub/sub |

> Use container name `redis`/`postgres`, not `localhost`. Three logical Redis DBs on one instance; at scale, swap URLs to separate instances.

#### AI Providers (optional — add as needed)

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter | LLM (Claude, GPT, Gemini — recommended, one key covers all) |
| `ANTHROPIC_API_KEY` | Anthropic | Claude direct |
| `OPENAI_API_KEY` | OpenAI | GPT direct |
| `GOOGLE_API_KEY` | Google | Gemini direct + image generation |
| `WAVESPEED_API_KEY` | WaveSpeed | Image, video, audio, 3D (~60 models) |
| `DASHSCOPE_API_KEY` | Alibaba | Qwen image + Wan video |
| `MINIMAX_API_KEY` | MiniMax | Music + Hailuo video + TTS |
| `ELEVENLABS_API_KEY` | ElevenLabs | TTS + music + SFX |

Without AI keys the server runs, but AIGC features won't work. Agent chat needs at least one LLM key (OPENROUTER recommended).

#### Storage (required for AIGC binary output)

| Variable | Description |
|----------|-------------|
| `STORAGE_PROVIDER` | `local` (default), `s3`, or `aliyun_oss` |
| `UPLOAD_BASE_URL` | CDN prefix for file URLs (e.g. `https://cdn.your-domain.com`) |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | AWS S3 / MinIO / Cloudflare R2 |
| `OSS_BUCKET` / `OSS_ENDPOINT` / `OSS_ACCESS_KEY` / `OSS_SECRET_KEY` | Aliyun OSS |

> `local` mode stores files in `./uploads/` (mounted as Docker volume). Works for small deployments. For production, use S3 or OSS with CDN.

#### Email (optional — for password reset)

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | Default `587` (TLS) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASSWORD` | SMTP password or app-specific password |

Without SMTP, the forgot-password feature won't send emails (the API still returns success to avoid leaking whether an email exists).

#### Google OAuth (optional)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

Configure in [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Add your domain to authorized JavaScript origins and redirect URIs.

#### Payment (optional)

| Variable | Description |
|----------|-------------|
| `PAYMENT_ENABLED` | `true` to enable (default: `false` = unlimited credits) |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |

### Docker Compose Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| `web` | nginx:1.27-alpine | 80, 443 | Frontend + reverse proxy + SSL auto-detect |
| `server` | breatic | 3000 (internal) | HTTP API + SSE |
| `collab` | breatic | 1234 (internal) | Hocuspocus WebSocket |
| `worker` | breatic | — | BullMQ task worker |
| `postgres` | postgres:16-alpine | 5432 | Database |
| `redis` | redis:7-alpine | 6379 | Cache + Queue + Streams |

> Image sizes: Backend ~357MB, Frontend (nginx) ~73MB. Total ~430MB.

### Common Operations

```bash
# View logs
docker compose logs -f server    # API server
docker compose logs -f worker    # BullMQ worker
docker compose logs -f collab    # Hocuspocus
docker compose logs -f web       # Nginx

# Rebuild after code changes
docker compose up -d --build

# Rebuild only frontend (after changing VITE_* vars)
docker compose build web && docker compose up -d web

# Scale workers for higher throughput
docker compose up -d --scale worker=3

# Manual database migration (normally auto-runs on startup)
docker compose run --rm --profile tools migrate

# Stop
docker compose down              # Stop containers
docker compose down -v           # Stop + delete data volumes (caution!)
```

### Backup & Restore

```bash
# Backup PostgreSQL
docker compose exec postgres pg_dump -U breatic breatic > backup.sql

# Restore PostgreSQL
docker compose exec -T postgres psql -U breatic breatic < backup.sql

# Backup Redis (all 3 DBs)
docker compose exec redis redis-cli BGSAVE
docker compose cp redis:/data/dump.rdb ./backup-redis.rdb

# Backup uploads (local storage mode)
tar czf backup-uploads.tar.gz uploads/
```

---

## SaaS Production

For running breatic.ai as a hosted service. Key differences from self-hosted:

- Managed database and Redis (no self-managed containers)
- External object storage (S3/OSS) + CDN
- CI/CD automated build and deployment
- Monitoring, alerting, and log aggregation

### Infrastructure

| Component | Recommended Service | Note |
|-----------|-------------------|------|
| Database | Managed PostgreSQL (RDS / Supabase / Neon) | Auto-backup, read replicas |
| Redis | Managed Redis (ElastiCache / Upstash / Aiven) | Persistence, 3 DBs or 3 instances |
| Storage | S3 / Aliyun OSS + CDN (CloudFront / Cloudflare) | `STORAGE_PROVIDER=s3` or `aliyun_oss` |
| Compute | Docker on VM / K8s / ECS | API + Collab + Worker containers |
| Frontend | Nginx container or CDN (Cloudflare Pages / Vercel) | Static files + reverse proxy |
| Domain | breatic.ai (prod), thinkai.cc (staging) | Cloudflare DNS + SSL. Nginx 301-redirects apex and every non-`www.*` host to `www.<domain>` — see [Canonical domain](#canonical-domain) |
| CI/CD | GitHub Actions | Build → Push to registry → Deploy |

### Environment Config

```bash
# Production (breatic.ai). The frontend bundle has no baked-in host —
# it resolves /api/* and /ws against window.location, so the same built
# image runs on breatic.ai, a staging domain, or a preview URL with zero
# rebuild. All that matters is that the browser, API, and WebSocket share
# one origin (nginx in the web container makes this true).
ENV=prod
DATABASE_URL=postgres://user:pass@rds-host:5432/breatic
REDIS_URL=redis://redis-host:6379/0
REDIS_QUEUE_URL=redis://redis-host:6379/1
REDIS_STREAM_URL=redis://redis-host:6379/2
STORAGE_PROVIDER=s3
PAYMENT_ENABLED=true

# Staging (thinkai.cc) — identical to prod apart from infra hosts
ENV=staging
```

### Canonical domain

Nginx enforces a single origin per deployment. Any host that is not
`www.<your-domain>` — including the bare apex `your-domain.com` and
alternate subdomains — gets a 301 redirect to `https://www.<your-domain>$request_uri`.

Why this matters in practice: browser `localStorage` is scoped per
origin. If a user lands on `https://breatic.ai` and logs in, the session
token only exists on that origin. Navigating to `https://www.breatic.ai`
would look unauthenticated (different origin → empty `localStorage`),
and the two tabs would silently disagree about auth state. Forcing one
canonical host makes the session unambiguous.

The same single-origin discipline is also what lets the frontend ship
without any baked-in API host. Because browser, API, and WebSocket all
resolve to `www.<your-domain>`, relative URLs in the frontend bundle
just work — no `VITE_API_URL`, no rebuild per environment.

#### If you edit `docker/nginx-ssl.conf`, do not drop `default_server`

The apex-redirect server blocks (on both `:80` and `:443`) are marked
`listen ... default_server` on purpose. `server_name _;` by itself is
**not** a catch-all — it is just a non-matching placeholder name that
never matches any `Host` header. Without an explicit `default_server`
directive, nginx routes "no server_name matched" requests to the
first `listen` block on that port, which would be the `www`-regex
block. That path serves the SPA for apex hosts and silently breaks
canonical enforcement (apex stays as apex, token split-brain returns).

Concretely: the config must keep both of these directives intact.

```nginx
server { listen 80  default_server; server_name _; return 301 https://www.$host$request_uri; }
server { listen 443 ssl default_server; server_name _; ...; return 301 https://www.$host$request_uri; }
```

### CI/CD Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to main:

1. Install dependencies (`pnpm install`)
2. Build packages (`pnpm turbo build --filter=@breatic/shared --filter=@breatic/core`)
3. TypeCheck (`pnpm turbo typecheck`)
4. Unit tests (server 65+ tests, shared i18n tests)
5. Docker image build
6. (TODO) Push to container registry + deploy to staging/production

### Scaling

| Service | Stateless? | Scale Strategy |
|---------|-----------|----------------|
| Server | Yes | Multiple replicas behind load balancer |
| Collab | Semi (Yjs docs in memory, synced via Redis DB 2) | Multiple instances, Redis pub/sub ensures sync |
| Worker | Yes | `--scale worker=N`, concurrency per instance in `config/worker.yaml` |

### Monitoring

- **Application logs**: main-thread `pino.multistream` (no worker thread, no pino-roll) writes `{service}.{yyyy-MM-dd}.log` synchronously to file + console; rotation is delegated to the container log driver / logrotate. Each entry has `timestamp` (ISO 8601) + `time` (epoch ms)
  - `logs/server/` — server (via `initLogger("server")`)
  - `logs/worker/` — BullMQ worker (via `initLogger("worker")`)
  - `logs/collab/` — Hocuspocus (via `initLogger("collab")`)
  - `logs/nginx/` — Nginx access + error (logrotate, 30-day retention)
- **Docker logs**: `docker compose logs -f <service>`
- **Health check**: Each application service exposes `GET /healthz` on a dedicated port. See the [Health check design](#health-check-design) section below for the full contract + docker healthcheck wiring.
- **Error tracking**: Sentry (set `VITE_SENTRY_DSN` in `.env`)

### Health check design

Per CLAUDE.md "服务器端工业级标准" mandate, each long-lived application service exposes a dedicated `GET /healthz` endpoint on a `主+1` style port. Docker compose declares `healthcheck:` for each container that probes its own `/healthz` and marks the container `unhealthy` on N consecutive failures; combined with `restart: unless-stopped` this closes the self-heal loop (a drifted container is killed and respawned automatically).

| service | main port | health port | check returns |
|---|---|---|---|
| server | 3000 | 3001 | `postgres` SELECT 1 + `redis_general` PING |
| collab | 1234 | 1235 | `redis_stream` PING + `hocuspocus_listening` Server.listening |
| worker | n/a(BullMQ subscriber, no main port) | 9101 | `redis_general` PING + `postgres` SELECT 1 |

The three health ports are part of the validated core config — `SERVER_HEALTH_PORT` / `COLLAB_HEALTH_PORT` / `WORKER_HEALTH_PORT` (defaults `3001` / `1235` / `9101`), declared in `packages/core/src/config/schema.ts` and read by each entry from the injected `env.*`. Override them in `.env` (see `.env.dev` / `.env.docker`) when a port collides; keep the docker `healthcheck:` probe target in sync.

Health endpoints are **container-internal only** — they are not routed through nginx and not exposed to the public internet. Probing happens via `docker exec <container> wget -q -O - http://localhost:<port>/healthz` or docker's built-in `healthcheck:` directive. The 200 / 503 contract is enforced inside the http server (`packages/core/src/infra/health-server.ts`) with a 2s per-check timeout so a slow-but-recovering dependency is distinguishable from a stuck one.

Why a dedicated port instead of reusing the main service port:

- per-port LB failure semantics stay clean (a health drift can be diagnosed independently from main traffic 5xx)
- main process freeze ≠ health endpoint stays alive (the independent `http.Server` instance fails its own port)
- naming consistent across all three services (`主+1` convention)
- aligns with how docker / k8s liveness probes are conventionally wired (separate port → separate readiness signal)

Beyond binary health, the **server** health port (3001) also serves `GET /metrics` — a minimal Prometheus surface: `http_requests_total` (by method + status), `db_up` (a SELECT-1 gauge; postgres.js exposes no live pool stats), and prom-client default process metrics. It is wired via the health server's optional `onMetrics` hook, so it stays container-internal exactly like `/healthz` (scrape via `docker exec breatic-server-1 wget -q -O - http://localhost:3001/metrics`). Worker / collab `/metrics` + Grafana dashboards remain tracked in `docs/ROADMAP.md`.

---

## Troubleshooting

### "Connection refused" to database

```bash
docker compose ps postgres
docker compose logs postgres
```

If using Docker, ensure `DATABASE_URL` uses `postgres` (container name), not `localhost`. Check that you copied from `.env.docker`, not `.env.dev`.

### Worker not processing tasks

```bash
docker compose logs worker
```

Check that `REDIS_QUEUE_URL` uses the correct container name (`redis`, not `localhost`).

### AIGC generation returns error

Most AIGC features require external API keys. Check that the relevant `*_API_KEY` is set in `.env`. The server runs without them, but generation endpoints return errors.

### Frontend can't connect to API/WebSocket

The frontend uses relative paths (`/api/*`, `/ws`) — the browser resolves them against `window.location`. If requests fail:

1. **Check the URL the browser is actually on** (`location.origin` in DevTools console). All API calls go to that same origin.
2. **Check nginx is reverse-proxying correctly** — pick any application endpoint that you know works (e.g. `curl -sI https://www.your-domain.com/api/v1/auth/me`) and confirm the response comes from the API container. `/healthz` is NOT public — it lives on each container's dedicated health port (3001 / 1235 / 9101) for docker healthcheck probes only.
3. **Docker compose changes** — if you edited `docker-compose.yml` or `Dockerfile.web`, rebuild: `docker compose build web && docker compose up -d web`. You no longer need to rebuild when the domain changes, because the domain isn't baked in.

### CORS errors in browser

Only relevant for **local development** if you bypass the Vite dev proxy (e.g. you point the frontend at `http://localhost:3000` directly instead of `/api`). Normally Vite's `server.proxy` makes the browser see a single origin (`localhost:8000`) and no CORS is needed.

Docker deployment also has no CORS — nginx reverse-proxies everything through one origin.

### SSL not working

1. Check cert files exist: `ls docker/certs/cert.pem docker/certs/cert.key`
2. Check entrypoint log: `docker compose logs web | head -3`
   - Should show: `[entrypoint] SSL certs found, enabling HTTPS`
3. Ensure port 443 is not blocked by firewall

### User says "I'm logged in but nothing works" — apex vs www split-brain

Symptom: user lands on the apex domain (`https://breatic.ai`), logs in,
then follows a link to `https://www.breatic.ai` (or vice versa) and is
silently logged out, or WebSocket never connects.

Cause: `localStorage` is scoped per origin. Two hosts = two separate
session stores. Check which host the browser is actually on.

Fix is already deployed — nginx 301-redirects everything that isn't
`www.*` to the canonical `www.` host. If you're seeing this symptom,
your nginx config or DNS is routing some traffic around the redirect.
Verify:

```bash
curl -I https://breatic.ai            # expect 301 → https://www.breatic.ai/
curl -I https://api.breatic.ai        # expect 301 → https://www.breatic.ai/
```

### Canvas deep link shows empty page / "add node" does nothing

The `/project/<id>` route depends on a session token being present in
Redux on first render. The token is hydrated from `localStorage.auth`
at store-init time (`packages/web/src/store/modules/userCenter.ts`), so
this should always work for a logged-in user.

If you're seeing this after a deploy: check that the frontend build
actually includes the fix (search the built bundle for
`loadInitialAuthInfo`). If the bundle is stale, rebuild:

```bash
docker compose build web
docker compose up -d web
```

### Forgot password email not sending

Check SMTP configuration in `.env`:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
```

The API always returns success (anti-enumeration), so check API logs for actual SMTP errors: `docker compose logs server | grep smtp`

### (Dev only) "登录已失效" banner stuck on `/project/:id` after a long-running dev session

Symptom: red banner `登录已失效 — 项目内容无法加载,请重新登录` shows on the
project page and does not clear even after a hard reload or
re-login. `GET /api/v1/auth/me` still returns `200` (cookie is
fine), only the WebSocket connection to collab keeps getting
`onAuthenticationFailed`.

Cause: `dev:collab` runs as a single long-lived `tsx` process
without an auto-restart loop. After several hours its postgres-js
connection pool (`max: 5`) tends to drift — Postgres closes idle
connections (default 30 min) but the pool keeps handing them out;
the next `loadProjectRole` query inside `onAuthenticate` throws,
collab reports `authenticationFailed`, and the front-end banner
latches sticky. Restarting collab gets a fresh pool and unblocks
everything. (Production runs collab inside Docker with a
much shorter lifetime so this never accumulates.)

Fix: restart `dev:collab`. From the repo root:

```bash
lsof -ti:1234 | xargs kill -TERM
pnpm dev:collab
```

Reflex: any time you see this banner in dev, your **first
diagnostic step** is `ps -p $(lsof -ti:1234) -o etime` — if
collab has been up for more than a couple of hours, restart
before looking at code.

The proper fix (postgres-js `max_lifetime` / `idle_timeout`
config, collab `/healthz` endpoint, onAuthenticate error
logging) is tracked as a follow-up — see the "follow-up issues"
section at the top of `docs/ROADMAP.md`.
