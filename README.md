# Breatic

The AI-native operating system for content creators — a unified workspace where AI agents plan, generate, and edit multimodal content (image, video, audio, 3D, text) through natural language. All creative assets live on a shared infinite canvas where teams collaborate in real time.

> **Status**: Backend TypeScript migration complete. Frontend is under development.

## Documentation

- [docs/DD-PROCESS.md](./docs/DD-PROCESS.md) — Due Diligence process for major decisions
- [docs/TDD-MANDATE.md](./docs/TDD-MANDATE.md) — Test-Driven Development discipline (AI-era mandate)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guide, commit conventions, commit author policy

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+ / TypeScript 5.x |
| Web Framework | Hono |
| Database | PostgreSQL (Drizzle ORM + postgres.js) |
| Cache & Pub/Sub | Redis (ioredis) |
| Task Queue | BullMQ |
| LLM Integration | Vercel AI SDK (OpenRouter, Anthropic, Google, OpenAI) |
| AIGC Providers | Wavespeed, Google, BytePlus, DashScope, Topaz, + more |
| Auth | Email+Password (bcrypt) / Google OAuth |
| Payment | Stripe (optional) |
| Storage | Local / S3 / Aliyun OSS |
| Realtime Collaboration | Hocuspocus 4.5.0 (Yjs) |
| Monorepo | Turborepo + pnpm |
| Testing | Vitest |
| Documentation | TypeDoc (TSDoc) |

## Architecture

```
breatic/                           # Turborepo monorepo
├── packages/
│   ├── shared/                    # Zod schemas, types, constants (shared)
│   ├── server/                    # API service (port 3000)
│   │   ├── src/
│   │   │   ├── routes/            #   Hono HTTP routes
│   │   │   ├── middleware/        #   Auth, CORS, logging, error handler
│   │   │   ├── agent/             #   Chat agent: streaming loop, prompt, SSE
│   │   │   ├── modules/           #   Business modules (Repo + Service per domain)
│   │   │   ├── infra/             #   Metrics and other server-local infrastructure
│   │   │   └── config/            #   Server-local YAML config loaders
│   │   └── vitest.config.ts
│   ├── core/                      # Shared kernel: db, redis, queues, config, auth, logging
│   ├── domain/                    # Business kernel shared by server + worker (agent, credit, tasks)
│   ├── worker/                    # BullMQ service
│   │   └── src/                   #   handlers/ (4 execution paths) + providers/ (image/video/audio/tts/3d/understand)
│   ├── collab/                    # Hocuspocus service (COLLAB_PORT, default 1234)
│   │   └── src/                   #   Yjs sync, auth, persistence, task result listener
│   └── web/                       # Frontend (React + Vite)
├── config/                        # YAML configs (agent, collab, worker, pricing, text-tools, models/)
├── skills/                        # Built-in skill definitions (knowledge + declared tools)
├── docker-compose.yml             # Deployment stack — pulls pre-built images from GHCR
├── Dockerfile                     # Backend image (API/Worker/Collab/Migrate shared, 357MB). Built by CI, published to ghcr.io/orime-org/breatic
└── Dockerfile.web                 # Frontend image (Vite build → nginx:alpine, 73MB). Built by CI, published to ghcr.io/orime-org/breatic-web
```

Dockerfiles are the single source of truth for image builds. CI runs them on every push; contributors and deployers don't need to invoke them in the default workflows but are free to audit or build locally for debugging.

**4 containers in production**: Web (nginx, port 80) | API (Hono) | Collab (Hocuspocus) | Worker (BullMQ)

### Core Flow

```
User Chat → MainAgent (AI SDK streamText) → TaskPlan → BullMQ → Worker
                                                                  │
                                                        Redis task-results
                                                                  │
                                                     Hocuspocus (Collab) → write Yjs doc
                                                                  │
                                                        Yjs sync → all connected clients
```

### Two-Layer Memory

| Layer | Scope | Storage |
|-------|-------|---------|
| Project Memory | One row per member per project | `project_memories` table |
| Conversation Memory | Per-conversation context | `conversation_memories` table |

Both layers are the member's own: a project row is keyed by `(user_id, project_id)`, so what one member's agent summarised is never handed to another's prompt.

Memory is consolidated by the LLM in front of the reply, on a turn whose assembled request measures past `memory_budget_chars` (default 850,000). The oldest turns are taken until what remains is under `memory_keep_chars` (default 500,000), and each consolidation **rewrites** the full memory content (not append), bounded by `memory_conversation_max_size`.

**Turn-based context management**: Each message carries a `turnIndex` (increments on every user message). When building LLM context, tool results older than the last `tool_result_keep` (default 3) tool uses are replaced with a placeholder; the calls themselves, assistant text and user prose are kept. Model `thinking` content is stored for debugging but never sent back to the LLM.

### Agent & Skill System

**Skills** are the unit of work. A skill fixes three things — its knowledge (`SKILL.md`), the tools it may use, and the model it runs on — and one factory resolves all three, so every entry point that runs a skill runs it the same way. The model is the only optional one: a skill that names none takes the configured default, which is what every shipped skill does today. Where a skill may be used and who may fire it are the host's decision, and live in `config/skill-routing.yaml` rather than in the skill.

```
skills/{name}/
├── SKILL.md          # Frontmatter (name, description) + LLM instructions
├── metadata.json     # Runtime config: model, tools, category, output_type, requires
└── references/       # Optional reference docs loaded on demand
```

A skill declares which tools it may use; the host assembles the tool set and the model calls them within one turn.

## Quick Start

Deployers and developers follow two independent paths. Pick whichever matches what you want to do — the paths don't depend on each other.

### I want to run Breatic (deployment)

Pulls pre-built images from GHCR. You don't need Node, pnpm, or any source code changes — just Docker.

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.docker .env
# Edit .env: DATABASE_URL, Redis URLs, API keys
docker compose up -d
```

Images default to `:latest` (= `main` branch). To pin a specific version or follow a staging branch, set `BREATIC_TAG` in `.env`:

```bash
# In .env:
BREATIC_TAG=test_thinkai_cc   # track the test branch
# or BREATIC_TAG=1.2.3         # pin a released version
```

### I want to contribute code (development)

Runs API / Worker / Collab as native Node processes with hot-reload. Docker is only used for the PostgreSQL and Redis services — app code is read directly from the workspace.

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
pnpm install

docker compose up -d postgres redis    # only infrastructure
cp .env.dev .env                       # localhost URLs
mv uploads.example uploads             # first-time only
pnpm db:migrate                        # once, or after pulling new migrations
pnpm dev                               # turbo starts API + Worker + Collab + Vite
```

Vite dev server listens on `VITE_DEV_PORT` (default `http://localhost:8000`) and proxies `/api/*` / `/ws` / `/uploads/*` to the backend, mirroring what nginx does in production. Proxy targets are derived from the backend's own `PORT` / `COLLAB_PORT`, so several worktrees can run `pnpm dev` side by side — see the header of `.env.dev`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution flow.

Useful commands:

```bash
pnpm test          # unit tests (mocked deps)
pnpm typecheck     # tsc --noEmit across all packages
pnpm lint          # ESLint
```

## Configuration

All settings validated at startup via Zod. See `.env.dev` or `.env.docker` for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |

### AI Providers (optional)

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Text generation (Claude, GPT, Gemini via OpenRouter) |
| `WAVESPEED_API_KEY` | Image/video/audio/3D generation |
| `GOOGLE_API_KEY` | Google Gemini direct access |
| `ANTHROPIC_API_KEY` | Anthropic Claude direct access |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYMENT_ENABLED` | `false` | Enable Stripe billing |
| `STORAGE_PROVIDER` | `local` | `local`, `s3`, or `aliyun_oss` |
| `UPLOAD_BASE_URL` | — | CDN prefix for stored files (e.g. `https://resource.example.com`) |
| `ENV` | `dev` | `dev`, `staging`, `prod` |

## API Endpoints

All endpoints are under `/api/v1`:

| Prefix | Description |
|--------|-------------|
| `/auth` | Login, register, logout |
| `/chat` | Agent conversation (SSE streaming) |
| `/canvas` | Task creation, understand, SSE stream |
| `/mini-tools` | Editor panel tools: image/video/audio (async Worker) + text (SSE streaming) |
| `/projects` | Project CRUD |
| `/tasks` | Task status and history |
| `/skills` | Built-in + marketplace skills |
| `/payment` | Stripe checkout and webhooks |
| `/healthz` | Liveness probe — on a **dedicated port** (API `:3001`), not the main API port |

## Testing

```bash
# Unit tests (mocked deps, no Docker needed)
pnpm test

# Integration tests (requires Docker running)
pnpm test:integration

# Type checking
pnpm typecheck

# Linting
pnpm lint

# Generate API docs
pnpm docs
```

## Security

Breatic takes security seriously. Found a vulnerability? Please report
it privately — see [SECURITY.md](./SECURITY.md) for our disclosure
policy and reporting channel (`security@breatic.ai`).

Do **not** open public GitHub issues for security vulnerabilities.

## License

Breatic is released under the **Breatic Source-Available License v1.0**,
based on Apache 2.0 with additional conditions:

- No public-facing deployment without authorization (paid or free)
- Brand and copyright must be preserved across all components
- License revisions apply only prospectively — past contributions
  remain under the version in effect at commit time

See [LICENSE](./LICENSE) for the full text.

Commercial licensing: [licensing@orime.ai](mailto:licensing@orime.ai).

© 2026 Orime, Inc.

