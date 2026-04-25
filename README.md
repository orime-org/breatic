# Breatic

The AI-native operating system for content creators — a unified workspace where AI agents plan, generate, and edit multimodal content (image, video, audio, 3D, text) through natural language. All creative assets live on a shared infinite canvas where teams collaborate in real time.

> **Status**: Backend TypeScript migration complete. Frontend is under development.

## Documentation

- [docs/PRODUCT.md](./docs/PRODUCT.md) — Product design, three-panel layout, collaboration model, execution modes, API overview, AI model catalog (~50 models across 6 modalities)
- [docs/DEPLOY.md](./docs/DEPLOY.md) — Deployment guide (Docker Compose + nginx, configuration, troubleshooting)
- [docs/ROADMAP.md](./docs/ROADMAP.md) — Development roadmap (Backend, Frontend, DevOps)
- [docs/FRONTEND.md](./docs/FRONTEND.md) — Frontend architecture (React, ReactFlow, Yjs, state management)
- [docs/YJS.md](./docs/YJS.md) — Yjs document structure spec (canvas + node editor docs, state machine, event flow, concurrency)
- [docs/WORKTREE.md](./docs/WORKTREE.md) — Optional parallel worktree workflow for multi-session development
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guide, commit conventions, AI authorship policy

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
| Realtime Collaboration | Hocuspocus 3.4.4 (Yjs) |
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
│   │   │   ├── agent/             #   AI core (MainAgent, spawn SubAgents, tools, skills)
│   │   │   ├── providers/         #   AIGC providers (image/video/audio/tts/3d/understand)
│   │   │   ├── worker/            #   BullMQ job handlers (5 execution paths)
│   │   │   ├── modules/           #   Business modules (Repo + Service per domain)
│   │   │   ├── db/                #   Drizzle schema + client
│   │   │   ├── infra/             #   Redis, queues, session store, request context (AsyncLocalStorage)
│   │   │   └── config/            #   Environment + YAML config loaders
│   │   └── vitest.config.ts
│   ├── collab/                    # Hocuspocus service (port 1234)
│   │   └── src/                   #   Yjs sync, auth, persistence, task result listener
│   └── web/                       # Frontend (placeholder)
├── config/                        # YAML configs (agent, collab, worker, pricing, text-tools, models/)
├── agents/                        # SubAgent role definitions (*.md with frontmatter)
├── skills/                        # Built-in skill definitions (knowledge + scripts)
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

### Three-Layer Memory

| Layer | Scope | Storage |
|-------|-------|---------|
| User Memory | Cross-project preferences | `user_memories` table |
| Project Memory | Shared among collaborators | `project_memories` table |
| Conversation Memory | Per-conversation context | `conversation_memories` table |

Memory is automatically consolidated by the LLM when the conversation exceeds `memory_window` **turns** (default 20). Each consolidation **rewrites** the full memory content (not append), keeping it concise.

**Turn-based context management**: Each message carries a `turnIndex` (increments on every user message). When building LLM context, the last `full_detail_turns` (default 3) turns keep full step detail (tool calls + results); older turns are compressed to user message + assistant final reply only. Model `thinking` content is stored for debugging but never sent back to the LLM.

### Agent & Skill System

**Agents** define _who_ does the work (role, tools, model). **Skills** define _how_ to do the work (knowledge, instructions, scripts). The two are orthogonal and composable.

```
agents/{name}.md      # SubAgent role definition (frontmatter: name, tools, model, skills + system prompt)
skills/{name}/
├── SKILL.md          # Frontmatter (name, description) + LLM instructions
├── metadata.json     # Runtime config: tools, category, output_type, scope, requires
├── scripts/          # Self-contained scripts invoked via run_script tool (path-sandboxed)
└── references/       # Optional reference docs loaded on demand
```

Built-in agents: `researcher` | `prompt_optimizer` | `analyst` | `planner`. SubAgents inherit the request context (memory + compressed conversation history) via AsyncLocalStorage.

## Quick Start

Deployers and developers follow two independent paths. Pick whichever matches what you want to do — the paths don't depend on each other.

### I want to run Breatic (deployment)

Pulls pre-built images from GHCR. You don't need Node, pnpm, or any source code changes — just Docker.

```bash
git clone https://github.com/orime-org/breatic.git
cd breatic
cp .env.docker .env
# Edit .env: SESSION_SECRET_KEY, DATABASE_URL, Redis URLs, API keys
docker compose up -d
```

Images default to `:latest` (= `main` branch). To pin a specific version or follow a staging branch, set `BREATIC_TAG` in `.env`:

```bash
# In .env:
BREATIC_TAG=test_thinkai_cc   # track the test branch
# or BREATIC_TAG=1.2.3         # pin a released version
```

See [docs/DEPLOY.md](./docs/DEPLOY.md) for Nginx/SSL/CI details and the image tag reference.

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

Vite dev server listens on `http://localhost:8000` and proxies `/api/*` / `/ws` / `/uploads/*` to the backend, mirroring what nginx does in production. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution flow.

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
| `SESSION_SECRET_KEY` | Session signing key |
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
| `LOGIN_MODE` | `WithAccount` | `WithAccount` or `NoAccount` |
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
| `/health` | Health check |

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

## Roadmap

See [docs/ROADMAP.md](./docs/ROADMAP.md) for the full development roadmap.

## Security

Breatic takes security seriously. Found a vulnerability? Please report
it privately — see [SECURITY.md](./SECURITY.md) for our disclosure
policy and reporting channel (`security@breatic.ai`).

Do **not** open public GitHub issues for security vulnerabilities.

## License

Breatic is released under the **Breatic Open Source License v1.0** —
a source-available license based on Apache 2.0, with additional
conditions:

- No public-facing deployment without authorization (paid or free)
- Brand and copyright must be preserved across all components
- License revisions apply only prospectively — past contributions
  remain under the version in effect at commit time

See [LICENSE](./LICENSE) (English, legally binding) or
[LICENSE.zh.md](./LICENSE.zh.md) (中文译本,仅供参考).

Commercial licensing: [licensing@orime.ai](mailto:licensing@orime.ai).

© 2026 Orime, Inc.
