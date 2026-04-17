# Changelog

## 2026-04-17

- **Auth hydration at store init** (#115): `userCenter` reducer now reads `localStorage.auth` in `loadInitialAuthInfo()` at module-import time, replacing the `useEffect` in `Workspace`. Deep links like `/project/<id>` no longer bypass hydration — Redux has the session token on the very first render, which was blocking Yjs from connecting (empty token → `enabled=false` → `addNode` silent no-op)
- **Canvas loading overlay removed** (#114): the project page already owns a top-level loading while `useYjsStore` syncs. The inner canvas-level overlay was redundant duplication
- **Yjs WebSocket session token auth** (#113, BUG-046): replaced the hardcoded `token: 'dev'` in `yjsManager.ts` with an explicit required `token` parameter plumbed from the Redux auth slice. `HocuspocusProvider.onAuthenticationFailed` calls `provider.disconnect()` + user-supplied callback to break the close→reconnect loop when Hocuspocus rejects the token in prod (`NoAccount` mode is dev-only)
- **Canonical domain (apex → www) + strict env** (#112): nginx serves only `www.*` and 301-redirects all other hosts, eliminating the localStorage split-brain between apex and `www`. Removed all silent fallbacks from `yjsManager.ts` and `request.ts` — missing `VITE_API_URL`/`VITE_WS_URL` now throws at startup so distributed deployments can't quietly misroute traffic
- **VITE_API_URL drops `/api` suffix** (#111): axios prepends `/api/v1/` itself; including it in the env caused `/api/api/v1/*` double-prefix 404s. `.env.docker` and `DEPLOY.md` updated accordingly
- **Frontend served from nginx root** (#110): removed the `/breatic/` Vite base path. Nginx already serves the SPA at `/`
- **Fail-fast connectivity check** (#108): API/Worker/Collab call `checkInfraReady()` at boot and exit immediately if PG/Redis are unreachable, with a clear error — prevents silent hangs
- **Independent migration service** (#107): `pnpm db:migrate` is now an explicit standalone step. Docker gets a dedicated `migrate` container that runs once and exits, decoupled from API/Worker startup. `dev` mode does not auto-migrate

## 2026-04-11

- **Canvas Yjs-first architecture**: flipped frontend data flow from Redux-first (500ms debounce + whole-array replace) to Yjs-first (direct Y.Map writes → observe → Redux read cache). Deleted `yjsStoreSync.ts` + `yjsSliceSyncs.ts` bridge. New: `useCanvasYjs.ts` observe hook, `canvasYjsRef.ts` module-level manager ref (#53)
- **Canvas Map-of-Maps structure**: replaced plain JS array `canvas.nodes` with `canvas.nodesMap: Y.Map<nodeId, Y.Map>` + `canvas.edges: Y.Map<edgeId, Y.Map>`. Each node is independent: prompt as Y.XmlFragment (TipTap-ready), attachments as Y.Array, params as Y.Map. O(1) node lookup, no cross-node interference (#51, #52)
- **Security audit (6 findings)**: Google JWT verification (#46), skill file-tool sandbox + SSRF blocklist (#47), cross-tenant ownership checks across REST + Collab layers (#48)
- **AIGC billing idempotency**: provider_result_url sentinel + billed_at CAS guard + no-retry-after-provider policy (#45)
- **Real project duplication**: `POST /projects/:id/duplicate` copies project row + all Yjs documents in a single transaction; fix projects API response envelope (#50)
- **Workspace API migration**: RecentProjects + UseCase components migrated from localStorage to projectsApi (#49)
- **Canvas node state sync**: API acquires Redis SETNX lock on `${env}:canvas:lock:*` (2h TTL) and publishes `handling` NodeEvent to `${env}:stream:canvas-nodes`; Worker publishes `completed` / `failed` on completion; Collab consumes via `nodesMap.get(nodeId).set(field, value)` direct Y.Map writes, releasing the lock on terminal events (#42)
- **Redis Streams transport**: migrated from Redis pub/sub to Streams for task-results / canvas-nodes event bus. Durable resume via persisted last-id; Collab restarts no longer drop in-flight events (#41)
- **Yjs document spec**: [docs/YJS.md](./docs/YJS.md) covering canvas Map-of-Maps shape, CanvasNodeFields / AttachRef types, ownership table, NodeEvent flow, undo/redo scoping, node lock semantics, PG persistence + Redis cross-instance sync (#43, #51, #52)
- **Upload / node_history recovery**: cherry-picked PR #31 (unified asset upload) and soft-delete refactor back into main after they were lost during the git-filter-repo AI-authorship cleanup (#40)
- **Unified asset upload**: two-phase `/prepare` → PUT → `/complete` flow with presigned URLs for S3/OSS and a local fallback endpoint. Context routing: agent writes `conversation_attachments` with 50/conversation cap, canvas writes `node_history` silently, editor returns metadata only. Video cover extraction reused on complete (#31)
- **Soft-delete mandate**: migration 0005 adds `deleted_at` to conversations / tasks / skill_installs. Repo/service layer exposes `softDelete*()` methods; list queries filter `isNull(deletedAt)`. CLAUDE.md codifies the rule and points to CONTRIBUTING.md (#31)
- **node_history table**: migration 0003 + `GET /api/v1/canvas/nodes/:nodeId/history` lists per-node generation results (success + failed) and user uploads ordered by most recent. Worker writes `generation` entries, upload endpoint writes `upload` entries (#30)
- **AI authorship policy**: `.husky/commit-msg` + `.github/workflows/no-ai-attribution.yml` block author/co-author trailers that name Claude/Anthropic/GPT/Copilot/Cursor/ChatGPT/Codex. CONTRIBUTING.md explains the US copyright rationale (#33, #35)
- **Docs reorganized**: `docs/` for handwritten docs (DEPLOY/FRONTEND/PRODUCT/ROADMAP/WORKTREE/YJS); `api-reference/` for TypeDoc output (gitignored); root-level keeps README/CLAUDE/CONTRIBUTING/CHANGELOG/LICENSE. Fixed the pre-existing bug where `turbo run docs` silently ran nothing because `packages/server/package.json` had no `docs` script (#37, #38)

## 2026-04-09 (continued)

- **Storage unified in Worker**: transports return raw `{buffer, contentType}`, Worker handles all persist logic (buffer upload + CDN URL download → permanent storage). `storageKey()` uses structured `{userId, projectId, taskType, ext}` format (#20)
- **Model catalog streamlined**: ~102 → 50 models, removed cost-inefficient variants. Deleted 6 video transports, 3 TTS models, 4 3D models, 2 understand models (#21)
- **AIGC duration tracking**: `duration_ms` column on tasks table, `performance.now()` timing in Worker, exposed in API response (#22)
- **OSS storage verified**: Aliyun OSS upload end-to-end with CDN prefix `UPLOAD_BASE_URL`. Image (nano-banana-pro, 54s) + Audio (minimax-music-2.5, 119s) verified (#23)
- **WaveSpeed null param fix**: all 4 WaveSpeed transports strip null/undefined from request body; MiniMax lyrics fallback for instrumental mode (#23)
- **DB auto-migrate**: `runMigrations()` called at API + Worker startup, Drizzle lock table prevents concurrent conflicts (#24)
- **Docker image optimized**: 1.12GB → 357MB via `pnpm deploy --filter --prod` + `turbo --filter` (skip web build) (#25)
- **Nginx reverse proxy**: `Dockerfile.web` (73MB nginx:alpine), unified entry on port 80. Routes: `/api/*` → API, `/ws` → Collab, `/uploads/*` → API, `/*` → frontend SPA fallback (#26)
- **VITE_API_URL / VITE_WS_URL**: must be explicitly configured for all deployment scenarios (self-hosted, SaaS, local dev) (#26)

## 2026-04-09

- **AIGC pipeline end-to-end**: canvas/tasks → BullMQ → Worker → WaveSpeed API → download → local storage → permanent URL. Verified with z-image-turbo.
- **Local storage adapter**: `STORAGE_PROVIDER=local` (default), files stored in `uploads/{type}/{uuid}.ext`, served via `/uploads/*` static route
- **Storage refactor**: split monolithic storage.ts into `storage/index.ts` + `local.ts` + `s3.ts` + `oss.ts`. Each adapter implements `upload()` + `persistFromUrl()`
- **Credit recording**: always write to `credit_transactions` regardless of `PAYMENT_ENABLED`. New columns: `tokens_used`, `model`, `provider`
- **LLM routing fallback**: auto-fallback to OpenRouter when direct provider key (anthropic/google/openai) not configured
- **dotenv from root**: server loads `.env` from monorepo root, not `packages/server/`
- **Daily log rotation**: pino-roll, per-service directories (`logs/api/`, `logs/collab/`, `logs/worker/`)
- **Pre-commit hook**: `.husky/pre-commit` blocks `.env`, `.pem`, `.key` files from being committed
- **Google OAuth route**: `POST /api/v1/auth/google` — accepts Google ID token, returns session
- **i18n unified**: merged backend YAML + frontend JSON → root `locales/*.json`, shared by all
- **Assets API**: `POST /api/v1/assets/upload-url` supports S3 + Aliyun OSS presigned URLs
- **uploads.example/**: user renames to `uploads/` on setup (like `.env.example`)

## 2026-04-08

- **API integration**: shared Zod schemas (@breatic/shared), 8 domain-based frontend API files, `GET /api/v1/auth/me`, unified root `.env.example`
- **Model audit**: add Luma Ray 3.14, Wan 2.7, VEO 3.1 Lite, Tripo3D V3.1, Hunyuan3D V3.1 Pro; remove 8 more obsolete models; fix unverified model IDs
- **Model tiering**: 104 models tagged with tier (44 recommended / 48 optional / 12 internal)
- **Model catalog API**: `GET /api/v1/models` — full catalog grouped by modality, filtered by API key availability
- **Model cleanup**: removed 37 obsolete models superseded by newer versions (141 → 104)

## 2026-04-07

- **AIGC model updates**: PixVerse V6, Luma Ray 3, Fish S2 Pro added; Sora removed (shut down)
- **Agent layer**: SubAgent separated from Skill — `agents/*.md` defines role, `skills/` defines knowledge
- **AsyncLocalStorage**: request context shared across MainAgent + SubAgents (memory, history, userId)
- **SubAgent context**: inherits 3-layer memory + compressed conversation history
- **SubAgent billing**: direct credit deduction (removed text footer hack)
- **exec → run_script**: sandboxed script execution, path traversal prevention
- **Turn-based memory**: turnIndex, memory_window by turns (20), old turn compression, thinking storage
- **Model config externalized**: default_model, consolidation_model → agent.yaml; text tool model → text-tools.yaml
- **DevOps**: Dockerfile, docker-compose, DEPLOY.md, GitHub Actions CI
- **FRONTEND.md**: architecture analysis of web package

## 2026-04-02

- **Skill scope system**: metadata.json `scope` field (agent / canvas)
- **Agent skills**: creative_research, brainstorm, prompt_engineer
- **SubAgent as spawn tool**: AI SDK parallel execution, prevents recursive spawn
- **LLM billing**: 3 paths (AIGC by cost / Text tools by token / Agent chat by token)
- **Memory consolidation**: auto-summarize at memory_window threshold

## 2026-04-01

- **TypeScript full-stack migration**: Python 23K → TypeScript 15K lines
- **Hocuspocus**: independent collab service with PG persistence + Redis sync
- **Stripe**: Checkout integration, 5 pricing tiers, webhook verification
- **Text mini-tools**: 10 AI text tools, SSE streaming, per-user lock
- **Unit tests**: 105 tests, all services covered
- **Worker**: BullMQ with YAML config (concurrency, retries, polling)

## 2026-03-27

- **Understand provider**: vision → understand rename, Whisper ASR, transcribe mode
- **Mini-tool APIs**: image (10 tools), video (7), audio (5), unified to 3 endpoints
- **Skill boundaries**: mode filtering, vision_analyze repositioned

## 2026-03-26

- **Audio/TTS/3D providers**: dual-layer architecture unified across all modalities
- **TTS voice catalog**: 99 voices (ElevenLabs 52 + MiniMax 17 + Gemini 30)
- **Config rename**: providers/ → models/

## 2026-03-24

- **Video provider**: 11 model families, 90 models, 8 modes, 10 providers
- **Video transports**: 9 official APIs + shared retry/polling utilities
- **Image YAML reorganization**: by model family (not by mode)
- **Direct execution**: AIGC tasks skip LLM when params are complete

## 2026-03-23

- **Image post-processing**: Topaz upscale/sharpen/denoise/restore/adjust, bg-remover
- **Credit system**: per-API-call billing (cost × multiplier), transport returns cost
- **Parameter validation**: lenient mode (unknown params dropped, invalid values fallback)

## 2026-03-21

- **Image provider dual-layer**: models/ (prompt formatting) + transports/ (HTTP)
- **Nano Banana LLM prompt**: DeepSeek V3 auto-enhancement, +17% quality
- **Dynamic skill model injection**: YAML-driven, API key filtered

## 2026-03-20

- **LLM provider**: LiteLLM integration, 100+ providers, 10 models × 5 providers
- **Image models**: 11 t2i + 9 edit models, 4 providers

## 2026-03-18

- **Model-centric routing**: YAML per model, multi-provider with priority
- **AIGC concurrency control**: per-provider semaphore + 429 backoff
- **Agent config**: migrated to agent.yaml

## 2026-03-17

- **Architecture restructure**: 16 packages → 10
- **Skill system**: built-in only, auto-injected tools
- **Memory system**: 3-layer LLM rewrite (not append)
- **AIGC CLI scripts**: per-modality generate scripts
