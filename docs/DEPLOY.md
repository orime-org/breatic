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
                      DB 0    DB 1    DB 2    PG :5432
                   session   BullMQ  Streams
                    lock      queue   pub/sub
                  rate-limit
```

| Component | Description |
|-----------|-------------|
| **Nginx** | Reverse proxy + static files. Auto-detects SSL certificates at startup. |
| **API** | Hono HTTP server. Agent chat SSE, text mini-tool SSE, REST endpoints. |
| **Collab** | Hocuspocus WebSocket server. Yjs real-time sync, Redis Streams consumer. |
| **Worker** | BullMQ background processor. AIGC generation (image/video/audio/tts/3d). |
| **PostgreSQL** | Primary database (Drizzle ORM). Schema managed by explicit migration — `pnpm db:migrate` locally, `migrate` service in Docker. |
| **Redis** | 3 logical DBs: DB 0 (session/lock/rate-limit), DB 1 (BullMQ), DB 2 (Streams + Hocuspocus pub/sub). |

---

## Local Development

For writing code with hot reload. Only PostgreSQL and Redis run in Docker.

### Prerequisites

- Node.js 22+, pnpm 9+
- Docker (for PostgreSQL + Redis)

### Setup

```bash
git clone https://github.com/orime-org/breatic_ai.git
cd breatic_ai
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
| `REDIS_STREAM_URL` | `redis://localhost:6379/2` | Streams + Hocuspocus pub/sub |
| `VITE_API_URL` | `http://localhost:3000` | API direct |
| `VITE_WS_URL` | `ws://localhost:1234` | Collab direct |
| `ALLOWED_ORIGINS` | `http://localhost:8000` | Vite dev server (CORS) |

### Key Differences from Docker Deployment

- App code runs via `tsx watch` — changes auto-reload in seconds.
- Frontend uses Vite dev server with HMR (port 8000), not Nginx.
- No Nginx reverse proxy — frontend connects to API/Collab directly (CORS required).
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
# 1. Clone
git clone https://github.com/orime-org/breatic_ai.git
cd breatic_ai

# 2. Configure environment
cp .env.docker .env
# Edit .env — change these at minimum:
#   SESSION_SECRET_KEY=<random-string-min-16-chars>
#   VITE_API_URL=https://your-domain.com      # ⚠️ no /api suffix — frontend prepends /api/v1/
#   VITE_WS_URL=wss://your-domain.com/ws       # full WebSocket endpoint
#   VITE_BASE_URL=https://your-domain.com

# 3. (Optional) Enable HTTPS — place cert files
cp /path/to/your-cert.pem docker/certs/cert.pem
cp /path/to/your-cert.key docker/certs/cert.key

# 4. Build and start
docker compose up -d --build

# 5. Verify
curl http://localhost/api/health
# → { "status": "ok", "services": { "db": "ok", "redis": "ok" } }
```

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
| `VITE_API_URL` | API host seen by browser (no `/api` suffix — frontend prepends `/api/v1/...`) | `https://your-domain.com` |
| `VITE_WS_URL` | WebSocket URL seen by browser | `wss://your-domain.com/ws` |
| `VITE_BASE_URL` | Frontend base URL | `https://your-domain.com` |

> `VITE_*` variables are baked into the frontend at Docker build time. After changing them: `docker compose build web && docker compose up -d web`

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
| `api` | breatic | 3000 (internal) | HTTP API + SSE |
| `collab` | breatic | 1234 (internal) | Hocuspocus WebSocket |
| `worker` | breatic | — | BullMQ task worker |
| `postgres` | postgres:16-alpine | 5432 | Database |
| `redis` | redis:7-alpine | 6379 | Cache + Queue + Streams |

> Image sizes: Backend ~357MB, Frontend (nginx) ~73MB. Total ~430MB.

### Common Operations

```bash
# View logs
docker compose logs -f api       # API server
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
# Production (breatic.ai) — all VITE_* use the canonical www. host so the
# frontend, API calls, and WebSocket all share one origin. Apex is 301'd to
# www by nginx; see "Canonical domain" below for why.
ENV=prod
VITE_API_URL=https://www.breatic.ai          # host only, frontend prepends /api/v1/
VITE_WS_URL=wss://www.breatic.ai/ws          # full WebSocket endpoint
VITE_BASE_URL=https://www.breatic.ai
DATABASE_URL=postgres://user:pass@rds-host:5432/breatic
REDIS_URL=redis://redis-host:6379/0
REDIS_QUEUE_URL=redis://redis-host:6379/1
REDIS_STREAM_URL=redis://redis-host:6379/2
STORAGE_PROVIDER=s3
PAYMENT_ENABLED=true

# Staging (thinkai.cc)
ENV=staging
VITE_API_URL=https://www.thinkai.cc
VITE_WS_URL=wss://www.thinkai.cc/ws
VITE_BASE_URL=https://www.thinkai.cc
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

The `VITE_*` env vars above must use the same canonical host, otherwise
the built frontend will call APIs on the wrong origin and the browser
will either CORS-block them or silently fail the WebSocket handshake.

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
| API | Yes | Multiple replicas behind load balancer |
| Collab | Semi (Yjs docs in memory, synced via Redis DB 2) | Multiple instances, Redis pub/sub ensures sync |
| Worker | Yes | `--scale worker=N`, concurrency per instance in `config/worker.yaml` |

### Monitoring

- **Application logs**: Daily rotation (pino-roll), each entry has `timestamp` (ISO 8601) + `time` (epoch ms)
  - `logs/api/` — API server (via `initLogger("api")`)
  - `logs/worker/` — BullMQ worker (via `initLogger("worker")`)
  - `logs/collab/` — Hocuspocus (standalone logger)
  - `logs/nginx/` — Nginx access + error (logrotate, 30-day retention)
- **Docker logs**: `docker compose logs -f <service>`
- **Health check**: `GET /api/health` — returns DB + Redis connectivity status
- **Error tracking**: Sentry (set `VITE_SENTRY_DSN` in `.env`)

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

`VITE_API_URL` and `VITE_WS_URL` are baked into the frontend at Docker build time. After changing:

```bash
docker compose build web
docker compose up -d web
```

### CORS errors in browser

Only relevant for **local development** (API on :3000, frontend on :8000 are different origins). Set `ALLOWED_ORIGINS=http://localhost:8000` in `.env`.

Docker deployment doesn't need CORS — Nginx proxies everything through one origin.

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

The API always returns success (anti-enumeration), so check API logs for actual SMTP errors: `docker compose logs api | grep smtp`
