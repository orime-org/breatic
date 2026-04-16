# Deployment Guide

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) 24+
- [Docker Compose](https://docs.docker.com/compose/install/) v2+
- A `.env` file (copy from `.env.example`)

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/orime-org/breatic_ai.git
cd breatic_ai

# 2. Create your .env file
cp .env.example .env
# Edit .env: set SESSION_SECRET_KEY, VITE_API_URL, VITE_WS_URL, and AI provider keys

# 3. Start everything (DB migrations run automatically on startup)
docker compose up -d

# 4. Verify
curl http://localhost/api/health
# → { "status": "ok", "services": { "db": "ok", "redis": "ok" } }
```

Your services are now running:
- **Web (nginx)**: http://localhost (port 80) — frontend + reverse proxy
- **API**: http://localhost:3000 (proxied via nginx at `/api`)
- **Collab (Hocuspocus)**: ws://localhost:1234 (proxied via nginx at `/ws`)
- **Worker**: Background process (no port)

> **Note**: Database migrations run automatically when the API and Worker start. No manual migration step needed.

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET_KEY` | Session signing key (any random string) |
| `DATABASE_URL` | PostgreSQL URL (default: `postgres://breatic:breatic@postgres:5432/breatic`) |
| `REDIS_URL` | Redis URL (default: `redis://redis:6379/0`) |

> **Note**: When running in Docker, use container names (`postgres`, `redis`) instead of `localhost` in URLs.

### Frontend (required — baked into Docker image at build time)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API URL (self-hosted: `https://www.example.com/api`, local dev: `http://localhost:3000`) |
| `VITE_WS_URL` | Hocuspocus WebSocket URL (self-hosted: `wss://www.example.com/ws`, local dev: `ws://localhost:1234`) |

### AI Providers (optional — add as needed)

| Variable | Provider | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | OpenRouter | LLM (Claude, GPT, Gemini via proxy) |
| `GOOGLE_API_KEY` | Google | Gemini direct, image generation |
| `ANTHROPIC_API_KEY` | Anthropic | Claude direct |
| `WAVESPEED_API_KEY` | WaveSpeed | Image, video, audio, 3D generation |

Without any AI keys, the server runs but AIGC generation features won't work. Agent chat requires at least one LLM key (OPENROUTER recommended).

### Payment (optional)

| Variable | Description |
|----------|-------------|
| `PAYMENT_ENABLED` | `true` to enable (default: `false` = unlimited credits) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

### Storage (required for AIGC that produces binary output)

| Variable | Description |
|----------|-------------|
| `STORAGE_PROVIDER` | `local`, `s3`, or `aliyun_oss` |
| `UPLOAD_BASE_URL` | CDN prefix for stored files (e.g. `https://resource.example.com`) |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` | AWS S3 config |
| `OSS_BUCKET` / `OSS_ENDPOINT` / `OSS_ACCESS_KEY` / `OSS_SECRET_KEY` | Aliyun OSS config |

## Docker Compose Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| `web` | nginx:1.27-alpine | 80 | Frontend + reverse proxy (unified entry point) |
| `api` | breatic (357MB) | 3000 | HTTP API + Agent chat SSE |
| `collab` | breatic (357MB) | 1234 | Hocuspocus WebSocket (Yjs sync) |
| `worker` | breatic (357MB) | — | BullMQ task worker |
| `postgres` | postgres:16-alpine | 5432 | Database |
| `redis` | redis:7-alpine | 6379 | Cache + Queue + Pub/Sub |

> **Image sizes**: Backend 357MB, Frontend (nginx) 73MB. Total ~430MB (optimized from 1.12GB via `pnpm deploy --filter --prod`).

## Common Operations

### View logs

```bash
docker compose logs -f api       # API server logs
docker compose logs -f worker    # Worker logs
docker compose logs -f collab    # Hocuspocus logs
docker compose logs -f web       # Nginx logs
```

### Rebuild after code changes

```bash
docker compose build
docker compose up -d
```

### Run database migration manually

Migrations run automatically on startup. For manual runs:

```bash
docker compose run --rm --profile tools migrate
```

### Scale workers

```bash
docker compose up -d --scale worker=3
```

### Stop everything

```bash
docker compose down         # Stop containers
docker compose down -v      # Stop + delete data volumes
```

## Local Development (without Docker)

If you prefer running services directly:

```bash
# Prerequisites: Node.js 22+, pnpm 9+, PostgreSQL 16+, Redis 7+

pnpm install
pnpm build

# Start PostgreSQL + Redis (e.g. via Docker)
docker compose up -d postgres redis

# Configure environment
cp .env.example .env

# Start services (3-4 terminals) — migrations run automatically
pnpm dev          # API on :3000
pnpm dev:collab   # Hocuspocus on :1234
pnpm dev:worker   # BullMQ worker
# Frontend (if not using pnpm dev which starts all via turbo):
cd packages/web && pnpm dev  # Vite on :8000
```

## Troubleshooting

### "Connection refused" to database

Make sure PostgreSQL is healthy:
```bash
docker compose ps postgres
docker compose logs postgres
```

If using Docker, ensure `DATABASE_URL` uses `postgres` (container name), not `localhost`.

### Worker not processing tasks

Check worker logs:
```bash
docker compose logs worker
```

Ensure `REDIS_URL` points to the correct Redis instance.

### AIGC generation returns error

Most AIGC features require external API keys. Check that the relevant `*_API_KEY` is set in `.env`.

### Frontend can't connect to API/WebSocket

Check that `VITE_API_URL` and `VITE_WS_URL` are set correctly in `.env`. These are baked into the frontend at Docker build time — rebuild the web image after changing them:

```bash
docker compose build web
docker compose up -d web
```
