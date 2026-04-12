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
├── docker-compose.yml             # Web (nginx) + API + Collab + Worker + PostgreSQL + Redis
├── Dockerfile                     # Backend multi-stage (357MB)
└── Dockerfile.web                 # Frontend multi-stage: Vite → nginx:alpine (73MB)
```

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

### Prerequisites

- Node.js 22+
- [pnpm](https://pnpm.io/) 9+
- Docker (for PostgreSQL + Redis)

### Local Development

```bash
# Clone and install
git clone https://github.com/orime-org/breatic_ai.git
cd breatic_ai
pnpm install

# Start PostgreSQL + Redis
docker compose up -d postgres redis

# Configure environment
cp .env.example .env
# Edit .env: set SESSION_SECRET_KEY, VITE_API_URL, VITE_WS_URL, OPENROUTER_API_KEY, etc.

# Create uploads directory (for local AIGC file storage)
mv uploads.example uploads

# Start API server (port 3000) — DB migrations run automatically
pnpm dev

# Start Hocuspocus collab server (port 1234, separate terminal)
pnpm dev:collab

# Start BullMQ worker (separate terminal)
pnpm dev:worker

# Run tests
pnpm test
```

## Configuration

All settings validated at startup via Zod. See `.env.example` for the full list.

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

## License

Proprietary. All rights reserved. See [LICENSE](./LICENSE).
