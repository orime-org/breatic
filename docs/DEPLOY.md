# Deployment Guide

Breatic supports three deployment modes:

| Mode | Use Case | App Services | Database |
|------|----------|-------------|----------|
| [Local Development](#local-development) | Writing code, debugging | Local process (tsx watch, hot reload) | Docker container |
| [Self-Hosted](#self-hosted-deployment) | Open-source users, internal deploy | Docker container | Docker container |
| [SaaS Production](#saas-production) | breatic.ai | Docker / K8s | Managed service (RDS) |

## Architecture

```
                    ┌────────────────────────────────┐
  User Browser ───► │  Nginx (port 80/443)           │
                    │  ├── /           → Static files │
                    │  ├── /api/*      → API (:3000)  │
                    │  ├── /ws         → Collab(:1234)│
                    │  └── /uploads/*  → API (:3000)  │
                    └────────────────────────────────┘
                          │            │           │
                    ┌─────┴──┐  ┌──────┴──┐  ┌────┴────┐
                    │  API   │  │ Collab   │  │ Worker  │
                    │ :3000  │  │  :1234   │  │ (no port│)
                    └────┬───┘  └────┬─────┘  └────┬────┘
                         └───────────┼─────────────┘
                              ┌──────┴──────┐
                              │ PostgreSQL  │  Redis
                              │   :5432     │  :6379
                              └─────────────┘
```

- **Nginx**: Reverse proxy + static file server. All external traffic enters through one port.
- **API**: HTTP API + Agent chat SSE + text mini-tool SSE.
- **Collab**: Hocuspocus WebSocket server for Yjs real-time sync.
- **Worker**: BullMQ background task processor (AIGC generation). No port exposed.
- **PostgreSQL**: Primary database (Drizzle ORM, auto-migration on startup).
- **Redis**: Session store, BullMQ queue, Pub/Sub, canvas node locks, rate limiting.

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
cp .env.example .env
# Edit .env — defaults work for local dev
```

### Start Services

Open 3 terminals:

```bash
# Terminal 1: API server (port 3000, hot reload)
pnpm dev

# Terminal 2: Collab server (port 1234, hot reload)
pnpm dev:collab

# Terminal 3: Worker (hot reload)
pnpm dev:worker
```

Frontend starts automatically via turbo when running `pnpm dev`, or manually:

```bash
cd packages/web && pnpm dev  # Vite on :8000
```

### Local Dev Environment Variables

Default values in `.env.example` work out of the box:

| Variable | Value | Note |
|----------|-------|------|
| `DATABASE_URL` | `postgres://breatic:breatic@localhost:5432/breatic` | Docker PG |
| `REDIS_URL` | `redis://localhost:6379/0` | Docker Redis |
| `VITE_API_URL` | `http://localhost:3000` | API direct |
| `VITE_WS_URL` | `ws://localhost:1234` | Collab direct |
| `ALLOWED_ORIGINS` | `http://localhost:8000` | Vite dev server |

### Key Differences from Docker Deployment

- App code runs via `tsx watch` — changes auto-reload in seconds.
- Frontend uses Vite dev server with HMR (port 8000), not Nginx.
- No Nginx reverse proxy — frontend connects to API/Collab directly (CORS required).
- Database URLs use `localhost` (not container names).

---

## Self-Hosted Deployment

One command deploys everything. For open-source users and internal networks.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2+
- A domain with DNS pointing to your server (for HTTPS)

### Quick Start

```bash
git clone https://github.com/orime-org/breatic_ai.git
cd breatic_ai

cp .env.example .env
# Edit .env — see configuration below

docker compose up -d

# Verify
curl http://localhost/api/health
# → { "status": "ok", "services": { "db": "ok", "redis": "ok" } }
```

### Environment Variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SESSION_SECRET_KEY` | Session signing key (random string, min 16 chars) | `my-super-secret-key-2026` |
| `VITE_API_URL` | API URL seen by browser | `https://your-domain.com/api` |
| `VITE_WS_URL` | WebSocket URL seen by browser | `wss://your-domain.com/ws` |

> `VITE_*` variables are baked into the frontend at Docker build time. After changing them, rebuild: `docker compose build web && docker compose up -d web`

#### Database (defaults work for Docker)

| Variable | Default | Note |
|----------|---------|------|
| `DATABASE_URL` | `postgres://breatic:breatic@postgres:5432/breatic` | Use container name `postgres`, not `localhost` |
| `REDIS_URL` | `redis://redis:6379/0` | Use container name `redis`, not `localhost` |

#### AI Providers (optional — add as needed)

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter | LLM (Claude, GPT, Gemini — recommended) |
| `GOOGLE_API_KEY` | Google | Gemini direct + image generation |
| `ANTHROPIC_API_KEY` | Anthropic | Claude direct |
| `WAVESPEED_API_KEY` | WaveSpeed | Image, video, audio, 3D generation |

Without AI keys the server runs, but AIGC features won't work. Agent chat needs at least one LLM key.

#### Storage (required for AIGC binary output)

| Variable | Description |
|----------|-------------|
| `STORAGE_PROVIDER` | `local` (default), `s3`, or `aliyun_oss` |
| `UPLOAD_BASE_URL` | CDN prefix for file URLs |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | AWS S3 config |
| `OSS_BUCKET` / `OSS_ENDPOINT` / `OSS_ACCESS_KEY` / `OSS_SECRET_KEY` | Aliyun OSS config |

#### Payment (optional)

| Variable | Description |
|----------|-------------|
| `PAYMENT_ENABLED` | `true` to enable (default: `false` = unlimited credits) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

#### Google OAuth (optional)

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

### Docker Compose Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| `web` | nginx:1.27-alpine | 80 | Frontend + reverse proxy |
| `api` | breatic (357MB) | 3000 (internal) | HTTP API + SSE |
| `collab` | breatic (357MB) | 1234 (internal) | Hocuspocus WebSocket |
| `worker` | breatic (357MB) | — | BullMQ task worker |
| `postgres` | postgres:16-alpine | 5432 | Database |
| `redis` | redis:7-alpine | 6379 | Cache + Queue |

> Image sizes: Backend 357MB, Frontend (nginx) 73MB. Total ~430MB.

### HTTPS Setup

Docker exposes Nginx on port 80. For HTTPS, add a reverse proxy in front:

**Option A: Caddy (recommended — auto HTTPS)**

```
your-domain.com {
    reverse_proxy localhost:80
}
```

**Option B: Certbot + Nginx**

```bash
sudo certbot --nginx -d your-domain.com
```

### Common Operations

```bash
# View logs
docker compose logs -f api
docker compose logs -f collab
docker compose logs -f worker

# Rebuild after code changes
docker compose build && docker compose up -d

# Scale workers
docker compose up -d --scale worker=3

# Manual database migration
docker compose run --rm --profile tools migrate

# Stop
docker compose down           # Stop containers
docker compose down -v        # Stop + delete data volumes
```

---

## SaaS Production

For running breatic.ai as a service. Differs from self-hosted in:

- Managed database and Redis (RDS, ElastiCache, or equivalent)
- External object storage (S3/OSS) + CDN
- CI/CD automated deployment
- Monitoring and alerting

### Infrastructure

| Component | Service | Note |
|-----------|---------|------|
| Database | Managed PostgreSQL (RDS / Supabase / Neon) | Backups, replicas |
| Cache | Managed Redis (ElastiCache / Upstash) | Persistence enabled |
| Storage | S3 / Aliyun OSS + CDN | `STORAGE_PROVIDER=s3` or `aliyun_oss` |
| Compute | Docker on VM / K8s | API + Collab + Worker containers |
| Frontend | Nginx container or CDN | Static files + reverse proxy |
| Domain | breatic.ai (prod), thinkai.cc (staging) | Cloudflare or equivalent |

### Environment Config

```bash
# Production
VITE_API_URL=https://breatic.ai/api
VITE_WS_URL=wss://breatic.ai/ws
DATABASE_URL=postgres://user:pass@rds-host:5432/breatic
REDIS_URL=redis://redis-host:6379/0

# Staging
VITE_API_URL=https://thinkai.cc/api
VITE_WS_URL=wss://thinkai.cc/ws
```

### CI/CD Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to main:

1. Install dependencies
2. TypeCheck (server, collab)
3. Unit tests (server, shared)
4. Docker image build
5. (Optional) Push to container registry + deploy

### Scaling

| Service | Stateless? | Scale Strategy |
|---------|-----------|----------------|
| API | Yes | Multiple replicas behind load balancer |
| Collab | Semi (Yjs docs in memory, synced via Redis) | Multiple instances with Redis pub/sub |
| Worker | Yes | `--scale worker=N`, concurrency per instance configurable in `config/worker.yaml` |

### Monitoring

- **Application logs**: `logs/{api,collab,worker}/` with daily rotation (pino-roll)
- **Docker logs**: `docker compose logs -f <service>`
- **Health check**: `GET /api/health` returns DB + Redis status
- **Error tracking**: Sentry (optional, `VITE_SENTRY_DSN`)

---

## Troubleshooting

### "Connection refused" to database

```bash
docker compose ps postgres
docker compose logs postgres
```

If using Docker, ensure `DATABASE_URL` uses `postgres` (container name), not `localhost`.

### Worker not processing tasks

```bash
docker compose logs worker
```

Ensure `REDIS_URL` points to the correct Redis instance.

### AIGC generation returns error

Most AIGC features require external API keys. Check that the relevant `*_API_KEY` is set in `.env`.

### Frontend can't connect to API/WebSocket

`VITE_API_URL` and `VITE_WS_URL` are baked into the frontend at Docker build time. After changing:

```bash
docker compose build web
docker compose up -d web
```

### CORS errors in browser

Ensure `ALLOWED_ORIGINS` in `.env` matches the URL users access. For Docker deployment this is typically not needed (Nginx proxies everything through one origin). For local development, set to `http://localhost:8000`.
