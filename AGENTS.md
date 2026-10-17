# breatic agent rules

## Rule files

Rules for coding agents live only in `AGENTS.md` files: this one for the whole repository, `packages/<pkg>/AGENTS.md` for one package. Every `CLAUDE.md` holds the single line `@AGENTS.md` and nothing else; repo-lint `agent-rule-files` fails the build otherwise. Invoke `/editing-agent-rules` ([skill](.claude/skills/editing-agent-rules/SKILL.md)) before editing any `AGENTS.md`, `CLAUDE.md` or project skill.

## Project overview

breatic is an AI operating system for content creators: a TypeScript pnpm + turbo monorepo of 9 packages, with three Node services (`server`, `worker`, `collab`), the `web` front end and the `ingest` Cloudflare Worker. The product nouns are Studio, Project and Space (a Space type is canvas, document or timeline); never invent a `Workspace` entity or name.

| Read | When |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | before changing package structure, a data flow, configuration or anything else it describes; its Frontend part before web implementation work |
| [docs/DD-PROCESS.md](docs/DD-PROCESS.md) | before designing anything that hits a trigger in its section 1 |
| [docs/TDD-MANDATE.md](docs/TDD-MANDATE.md) | before writing tests for new or changed behaviour, and for critical-path test requirements |
| [docs/TEST-MANDATE.md](docs/TEST-MANDATE.md) | before writing or running smoke and E2E tests, or deciding which test tier a case belongs to |
| [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) | before scoping accessibility work or answering an accessibility finding |
| [self-host/DEVELOPMENT.md](self-host/DEVELOPMENT.md) | when setting up local development from scratch |

## Commands

```bash
cp .env.dev .env && docker compose up -d postgres redis  # first local run: Docker runs only Postgres and Redis; services run on the host, so DB and Redis URLs use localhost
pnpm db:migrate                 # from the repo root, after every pull or merge of main that brings migrations
git diff --name-only HEAD@{1} HEAD -- packages/core/src/db/migrations packages/core/src/db/migrations-yjs  # did it bring any?
pnpm dev                        # turbo builds dependencies first, then watches every service
pnpm db:journal-add <NNNN_name> # after hand-writing a migration (add --yjs for the Yjs database); never type the journal `when`
pnpm db:journal-repair          # once per database after a journal timestamp fix: read the report, then rerun with --apply
pnpm typecheck && pnpm lint && pnpm lint:repo && pnpm lint:dependency-cruiser && pnpm test && pnpm test:integration
pnpm lint:fix                   # adds missing license headers and rewrites relative imports to aliases
pnpm install --frozen-lockfile  # before pushing whenever a package.json or pnpm-workspace.yaml changed
```

Full Docker deployment: `cp .env.docker .env`, follow [self-host/LOCAL.md](self-host/LOCAL.md), then `docker compose up -d`. The CI check list is the `pnpm` lines in `.github/workflows/ci.yml`; read them before claiming a branch passes CI. To debug a running service, grep `logs/<service>/<service>.<yyyy-MM-dd>.log` (pino JSON); stdout is piped through turbo and cannot be read by killing the process. Starting, reusing or stopping `pnpm dev` and other long-lived processes: invoke `/dev-processes` ([skill](.claude/skills/dev-processes/SKILL.md)).

## Conventions

### Function definition format
**Every named function unit (function declaration, class, class method, arrow or function expression assigned to a variable) has a TSDoc comment, an explicit return type and `@throws {ErrorType}` for what it throws; types live in the signature, never in the comment.** Exported or private makes no difference; inline anonymous callbacks and tests are exempt. ESLint enforces it; read [docs/ARCHITECTURE.md#coding-standards-function-definition-format](docs/ARCHITECTURE.md#coding-standards-function-definition-format) before writing a doc comment you are unsure of.

### TypeScript strictness
**TypeScript is strict everywhere: no `any` (use `unknown`), no `var`, no `require()`.** The same lint level applies to every package, front end included.

- **Every first-party TypeScript file, tests included, starts with the two-line SPDX header (`// Copyright (c) 2026 Orime, Inc.` and `// SPDX-License-Identifier: LicenseRef-BSAL-1.0`); the shadcn vendor directory `packages/web/src/components/ui/` carries none.** `breatic/no-missing-license-header` checks both lines; `pnpm lint:fix` writes it.
- **Non-test code imports through the package's own alias (`@shared`, `@core`, `@domain`, `@collab`, `@worker`, `@server`, `@web`, `@ingest`, `@integration-tests`), never `./` or `../`, and nothing uses `@/`.** A unique prefix per package keeps imports resolvable when one package's source is compiled inside another's; `breatic/no-relative-import` enforces it and `pnpm lint:fix` rewrites violations. Judging whether a tsconfig alias is dead: invoke `/build-tooling` ([skill](.claude/skills/build-tooling/SKILL.md)).
- **There is no Prettier; formatting is ESLint's job.** Never run `prettier`: it reflows whole files against the ESLint `indent` rule. Fix format with `pnpm lint:fix` (`eslint --fix`), which touches only violating lines.
- **Test files live in a `__tests__/` directory beside the code they test (`breatic/test-file-location`).** When moving a test there, deepen its relative imports and the path argument of every `vi.mock("./x")`; a missed `vi.mock` path fails silently as `.mockResolvedValueOnce is not a function`.
- **`no-cjk` keeps CJK out of tracked and untracked non-ignored `.ts .mts .cts .tsx .css .yaml .yml .sh .mjs .cjs` files, every `AGENTS.md` and project skills; it exempts `locales/*.json`, its two allowlisted data files and test files (`TEST_FILE` in `repo-lint/src/file-kinds.ts`).** The test exemption exists only because the guard cannot tell required CJK from careless CJK: test names, assertions and comments are still English, and CJK is allowed only when the behaviour under test is multilingual or the data must be CJK. Scaffolding under `src/` that only tests import (`packages/web/src/test-utils/a11y.ts`) is scanned.
- **Runtime parameters (rate limits, page sizes, member caps, concurrency, timeouts, debounces) live in `config/*.yaml`, read through a zod loader with `.default()` and a getter; never write the number in code.** Rate limiting always goes through `rateLimitFor` in `packages/server/src/middleware/rate-limit.ts`. Deployment settings (ports, database, Redis, secrets, origins) are environment variables in the core env schema. Check: would operations or product want to change this without a code change? Yes → yaml; a contract bound such as a maximum string length → the zod schema.
- **Calls to our own backend from web use the axios instance in `packages/web/src/data/api/request.ts`; calls to anything external (cloud storage, vendor APIs, arbitrary URLs) use `httpRequest` from `@breatic/shared`, on both sides.** Bare `fetch` is blocked by `breatic/no-naked-fetch`.
- **Servers record time in UTC (`timestamp with time zone`, `now()`, microseconds); the wire carries absolute instants in the field's existing form (ISO string or epoch ms); web shows the reader's local time.** Check: turning a timestamp into text? Never slice the string (`iso.slice(0, 10)` is the UTC day), parse with `new Date(iso)` and pass `getLocale()` to every `toLocale*` call. Check: does a database timestamp pass through `Date` and back into a query, as keyset cursors do? Carry the full-precision text instead; `Date` drops microseconds and rows sharing a millisecond are skipped.
- **Adding a locale touches `locales/<code>.json`, `packages/web/src/i18n/locale-bootstrap.ts`, `packages/web/src/features/preferences/supported-langs.ts`, the locale-count assertions in `packages/core/src/__tests__/i18n-loader.test.ts` and `SUPPORTED` in `packages/server/src/middleware/i18n.ts`, then a full `pnpm test`.** The core loader discovers locales on its own and the server list falls back to English silently, so a web-only test run misses both.
- **On-screen presentation uses a third-party library whenever one fits (renderers, editors, charts, highlighting, virtual scroll, overlay positioning, animation); data formats, database schema, API contracts, domain models and state machines are always ours.** A library's bugs are fixed by everyone who uses it, and a third-party shape leaking into stored data is ours forever. Only two things justify building UI ourselves: no fitting library exists (name the ones checked) or none has a commercially usable licence.
- **A file is dead only when every exported symbol has no caller across the repository, searched one by one past barrel re-exports (excluding the file itself, barrels and tests).** Consumers import symbols through `index.ts` barrels, so a filename search finds nothing for live code. Read the docstring before deleting; if it contradicts the deletion, raise it.

## Architecture

### Shared or core
**`@breatic/shared` holds what web or the ingest Worker uses as well as the backend and must stay browser-safe ([packages/shared/AGENTS.md#browser-safe-dependencies-only](packages/shared/AGENTS.md#browser-safe-dependencies-only)); `@breatic/core` holds what only the Node backend shares.** The ingest Worker cannot load core, and a format written twice (such as the upload ticket in `packages/shared/src/upload/ticket.ts`) drifts until each side rejects the other's. Check: does web or the ingest Worker use it? Either → shared; neither → core. Main entry versus subpath entries: [packages/shared/AGENTS.md#main-entry-and-subpaths](packages/shared/AGENTS.md#main-entry-and-subpaths).

### Backend package boundaries
**Place backend code by who uses it: `@breatic/core` when collab and another service use it, or it is infrastructure, shared schema or a cross-service event; `@breatic/domain` when only server and worker use it (the AIGC business); otherwise the one service that uses it.** The dependency graph is `shared ← core ← {domain, collab}`, `domain ← {server, worker}`; dependency-cruiser enforces `library-no-app-import` and `collab-no-domain-import`. Inside a package, routes, worker handlers and collab hooks only translate protocol into service calls; services hold the business logic and never import `hono` (`service-no-hono`). Cross-service: a synchronous answer is a function call; asynchronous or fan-out work is a Redis event whose contract lives in core or shared.
- **Each table has one repository module; services call it and never write SQL (`breatic/no-raw-sql-outside-repo`).** Check: before calling a table single-owner, did a repository-wide search over `packages/*/src` find every read and write? A "X-owned" comment is not evidence, and the lint checks only where SQL is written, not how many repositories touch a table.
- **Drizzle types (`$inferSelect`, `$inferInsert`) stay inside `*.repo.ts`; repositories map rows to hand-written entities in `packages/shared/src/types/entities.ts` (`breatic/no-drizzle-type-leak`).** Exporting a new entity: [packages/shared/AGENTS.md#main-entry-and-subpaths](packages/shared/AGENTS.md#main-entry-and-subpaths).
- **The front end alone creates canvas nodes and sets their position and layout; the backend only updates an existing node's status and result.** The backend has no knowledge of layout.
- **Work that touches money, secrets or heavy compute (all AIGC, transcoding, very large file parsing) runs in the backend; pure media transforms a browser can handle (rotate, crop, split, compress, thumbnail) may run in web and upload their result like any upload.** Credits are charged only for calls to external AIGC models, wherever the work runs.

### Library packages do not read env
**`@breatic/core`, `@breatic/shared` and `@breatic/domain` never read `process.env` or load `.env`; each service's `src/bootstrap-config.ts`, the first import of its entry, calls `dotenv` and `initCore(process.env)` once.** `breatic/no-library-env-access` enforces it; how libraries then read configuration: [packages/core/AGENTS.md#config-is-injected-and-read-lazily](packages/core/AGENTS.md#config-is-injected-and-read-lazily).

### Library packages do not log
**The three library packages never call `logger.*` or `console.*`: they throw, or return a typed result or sentinel (`{ exists: false }`) when throwing is impossible.** Only the application layer knows the request context and whether to alert, so audit lines (`user_registered`, `payment_completed`) are logged by the route after the service returns, and event-emitter error listeners are attached by the service entry. `breatic/no-library-logger` enforces it.

### Library packages do not exit the process
**Library code never calls `process.exit()`; it throws a typed error (`InfraNotReadyError`) and the service entry catches it at top level, logs and exits.** Only the entry knows what exiting means for its service.

### AIGC generation runs in the worker
**Image, video and audio generation runs as BullMQ jobs in the worker, never synchronously inside a server request.** The only server modules that may call a model directly are the streaming entry points the dependency-cruiser rule `server-no-sync-aigc` allows: agent chat, memory consolidation and the Text mini-tool.

### Prompts pass through extractPromptText
**Every AIGC prompt passes through `extractPromptText()` (`packages/shared/src/agent/extract-prompt.ts`) first, which strips HTML, comments and invisible characters.**
- **Model output is not user-provided content; the rule against rendering user HTML (`packages/web/AGENTS.md`) does not decide how agent output is handled.** Check: did the user type this, or did our model produce it?

### Task time limit
**Every task on a canvas node (upload, generation, understanding, mini-tool, container tools) has one limit, two hours: `default_budget_ms` in `config/node-tasks.yaml`.** Container deadlines and worker waits take this value; a shorter limit kills healthy tasks inside their budget. Check: writing a timeout or deadline for a task? It is two hours; any other value is asked about first.

### Storage
**Cloudflare R2 is the only storage (`STORAGE_PROVIDER` accepts only `r2`), and the browser never writes to it directly.** The browser exchanges a signed ticket from `POST /assets/upload-ticket` and sends chunks to the ingest Worker, which writes R2 and hashes the bytes as it writes; our services finish the upload, and the Worker never calls us back. Check: who holds the bytes now?

| Bytes are | Path |
|---|---|
| in the browser | hash in the browser first; a dedup hit skips the upload |
| in our process (provider-returned audio) | upload first without hashing locally; dedup after the Worker reports |
| only a URL (AIGC temporary link, user link via `POST /canvas/ingest-url`) | hand the URL to the ingest Worker to fetch; never download and re-upload; a user URL is untrusted and is validated and rate-limited first |
| produced in a container we started | the container writes through the ingest Worker and registers like an upload |

Upload and generation paths only insert objects, never delete them (dedup losers are queued for offline reclaim); every URL a consumer stores comes from the registered record (`publicUrl(record.storage_key)`), never from a freshly written key; a failed registration is a failed upload; hash, size and content type come from the Worker's report on the stored bytes, never from client claims. Mechanism, thumbnails, covers and avatars: the storage paragraph of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) "Canvas collaboration".

## Server production standards

### Application-layer error logging
**Every `catch` at the application layer (server route, collab hook, worker job handler) logs `logger.error({ err, ctx })`; an empty or silent catch is forbidden.** Only that layer has the user, request and project context. Check: at 3am, could on-call trace the root cause from the logs alone? No → add the log and the metric before writing the catch.

### Health checks
**Each service exposes `/healthz` that probes every critical connection (each Postgres and Redis connection it uses), and its entry really calls the logger and `startHealthServer` (`breatic/service-observability`; repo-lint `service-entries-present` keeps the three entries existing).** A load balancer or orchestrator replaces an unhealthy instance; single-host `docker compose` does not (`restart:` reacts only to exits), so there recovery relies on monitoring alerts.
- **Auth failures, rate-limit hits, abnormal queries and pool exhaustion produce structured logs, and production reports error rate, pool size and acquire latency.**

### Graceful shutdown
**Every service shuts down gracefully on SIGTERM, finishing in-flight work before exiting, and every critical path has alerting plus retry or a degraded fallback.**

## Testing

- **Run tests from the repository root through turbo (`pnpm test`, `pnpm test:integration`), never `pnpm --filter <pkg> test` or `pnpm --filter <pkg> test:integration`.** turbo builds dependencies first; a filtered run reads stale `dist` of `@breatic/*` and fails with errors CI never shows (a missing column, `is not a function`). `test:smoke` and `test:visual` exist only in web and run as [packages/web/AGENTS.md#tests-and-smoke](packages/web/AGENTS.md#tests-and-smoke) says. Check: was this failure produced through turbo? No → rerun correctly before investigating.
- **Tests that import another package run against its `dist`, so after changing `shared`, `core` or `domain` source, run `pnpm build` before testing, including when mutating code to see whether a test protects it.** Check: did the code under test actually change? Zero red tests after a mutation means suspect the build first.
- Smoke and E2E: read [docs/TEST-MANDATE.md](docs/TEST-MANDATE.md) first and invoke `/smoke-e2e` ([skill](.claude/skills/smoke-e2e/SKILL.md)).

### Critical paths
**Payment, auth, data integrity, AI tool calls, credit deduction and Yjs collaboration need 100% test coverage, explicit invariants and property-based tests (`fast-check`); overall coverage below 80% does not block, an uncovered critical path does.** Definitions: [docs/TDD-MANDATE.md](docs/TDD-MANDATE.md#%E5%85%B3%E9%94%AE%E8%B7%AF%E5%BE%84%E5%AE%9A%E4%B9%896-%E7%B1%BB).

### Test-driven development
**New or changed behaviour follows [docs/TDD-MANDATE.md](docs/TDD-MANDATE.md); read it before writing tests.** It holds the anti-patterns, invariant tooling and how TDD follows DD.

### Due diligence
**A design that hits a trigger in section 1 of [docs/DD-PROCESS.md](docs/DD-PROCESS.md) (security model, cross-package, already shipped, architecture, state machine) runs the DD there before design work, starting with candidate enumeration.** A design's selection section carries a candidate table and a comparison matrix; one candidate is not an enumeration. A state-transition table is the one in section 9, filled for every place the fact is stored.

## Product scope

### Members are trusted
**A path that a legitimate project member can only trigger by deliberately harming another member, whose harm stays on that member's display and clears on refresh, gets no code defence and no todo.** This holds because members are invited by the owner or a studio admin, who sees and can remove them. It decides only whether to add a defence: a branch that breaks the server's own rules is deleted regardless. Not exempt: anything an outsider, an unauthenticated client or another tenant can trigger, and anything that crashes a service, leaks or corrupts data or reaches another project; those get entry-point enforcement.

- **The product is live with real users and data; Yjs document data evolves like any other production data.** Check: about to argue "not launched yet" or "no users"? That reason no longer exists.
- **breatic supports desktop web only: hover may be a primary interaction, and there are no tap fallbacks, touch gestures or mobile layouts.** A finding that touch is not covered is answered with this policy.
- **The product does not support screen readers: anything that only works with screen-reader support (`aria-label`, `aria-live`, `alt`, announcements, screen-reader-driven flows) is out of scope and never a defect, while keyboard reach, visible focus, readable contrast, understandable errors and semantic HTML are always built.** Viewers seeing and hearing existing content is a permission matter and fully supported. Answer screen-reader findings from any review with this policy; never claim WCAG 2.1 AA or EN 301 549 conformance, but describe what is done truthfully. Check: does anyone besides a screen-reader user benefit? Yes → build it. Read [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md) for the full boundary.
- **Membership tiers differ only in capacity, collaboration size, commercial use and governance; every creative feature and model works on every tier.** Check: about to switch off a generation feature by tier? Wrong; tiers only limit capacity.
- **"Stored in the database" means a SQL column; a key inside a Yjs document (stored as a blob in `yjs_documents.data`) is that document's internal structure and needs no schema justification.** A real SQL column keeps the full bar: soft delete, `created_at`, a hand-written migration.
- **"Tab" means a Space tab on the Project page, not a browser tab.** Closing a Space tab detaches that Space's Yjs document while the project connection stays alive.

## Public repository

- **This repository is public: commits, PR bodies, docs, comments and `.gitignore` notes must not name the private repository, expose internal service URLs or leak security-sensitive detail.** Say "private documentation" or "internal backlog" when internal material must be mentioned. `no-private-repo-path` enforces the naming half; a path fragment that names no private repository (`design/tokens.css`) is fine and is not reported.
- **`inner#N` (no space; N is the private issue or PR number) is the only way to point at private work; code comments point at the task issue, not a PR.** Wrong: `inner #N`, `inner issue #N`, `inner PR #N`, a path or document name. Right: `inner#123`.
- **`docs/` holds only long-lived constitution-level documents; progress, deployment runbooks and configuration registers do not go there, and adding or deleting a markdown file in this repository needs the maintainer's approval first.** Editing an existing file's content needs none. Check: is this document a constraint that rarely changes? No → it does not belong in `docs/`.
- **Docs carry no provenance markers (PR numbers, dates, history); `git blame` answers when.** Hex colours and numbered list items are not provenance.
- **A reference to a document that is not in this repository is deleted outright, never replaced with "see internal docs".**
- **Never read, write or grep a runtime `.env`, and never run a command that interpolates its values into output (`docker compose config`, `env`, `printenv`, dotenv CLIs, `envsubst`); the tracked templates `.env.dev` and `.env.docker` are fine.**
- **A PR updates the docs it affects: the touched `docs/*`, package `AGENTS.md` files and, when it restructures a package, that package's `AGENTS.md`, its `docs/ARCHITECTURE.md` section and its description here.**

## Prohibitions

Each is a rule above, enforced by lint where it can be: business logic in routes or `hono` in services and SQL or Drizzle types outside repositories ([boundaries](#backend-package-boundaries)); a bare `catch` ([logging](#application-layer-error-logging)); `any`, `var`, `require()` ([strictness](#typescript-strictness)); relative imports ([conventions](#conventions)); env reads, logging or `process.exit()` in library packages ([libraries](#library-packages-do-not-read-env)); synchronous AIGC ([worker](#aigc-generation-runs-in-the-worker)); hand-typed journal `when` and non-atomic credit deduction ([core](packages/core/AGENTS.md), [domain](packages/domain/AGENTS.md)).

## Index

| Package rules | Covers |
|---|---|
| [packages/collab/AGENTS.md](packages/collab/AGENTS.md) | Hocuspocus collaboration service |
| [packages/core/AGENTS.md](packages/core/AGENTS.md) | backend kernel: infrastructure, schema, migrations, auth, config |
| [packages/domain/AGENTS.md](packages/domain/AGENTS.md) | server and worker AIGC business: assets, credits, tasks, agent |
| [packages/ingest/AGENTS.md](packages/ingest/AGENTS.md) | Cloudflare upload Worker and media containers |
| [packages/integration-tests/AGENTS.md](packages/integration-tests/AGENTS.md) | cross-service integration tests |
| [packages/server/AGENTS.md](packages/server/AGENTS.md) | HTTP API, auth routes, SSE, agent |
| [packages/shared/AGENTS.md](packages/shared/AGENTS.md) | browser-safe shared code and entry points |
| [packages/web/AGENTS.md](packages/web/AGENTS.md) | React front end |
| [packages/worker/AGENTS.md](packages/worker/AGENTS.md) | BullMQ jobs and providers |

| Invoke | Before |
|---|---|
| [`/build-tooling`](.claude/skills/build-tooling/SKILL.md) | changing build, turbo, tsconfig, dependency or lint-guard setup, or when a local build or test run fails oddly |
| [`/postgres-drizzle`](.claude/skills/postgres-drizzle/SKILL.md) | writing schema, queries or migrations |
| [`/dev-processes`](.claude/skills/dev-processes/SKILL.md) | starting, reusing or stopping `pnpm dev` or any long-lived or load process |
| [`/smoke-e2e`](.claude/skills/smoke-e2e/SKILL.md) | writing or running smoke and E2E tests or verifying in a real browser |
| [`/tiptap-prosemirror`](.claude/skills/tiptap-prosemirror/SKILL.md) | changing the document Space editor |
| [`/canvas-reactflow`](.claude/skills/canvas-reactflow/SKILL.md) | changing the canvas Space, its nodes or canvas data |
| [`/web-layout-measure`](.claude/skills/web-layout-measure/SKILL.md) | layout, measurement, scrolling or overlay positioning work in web |
| [`/tailwind-tokens`](.claude/skills/tailwind-tokens/SKILL.md) | writing Tailwind classes, design tokens or CSS |
| [`/radix-shadcn`](.claude/skills/radix-shadcn/SKILL.md) | using or changing Radix or shadcn primitives, or evaluating a UI library |
| [`/react-state-traps`](.claude/skills/react-state-traps/SKILL.md) | writing hooks, effects, stores or optimistic updates |
| [`/web-unit-testing`](.claude/skills/web-unit-testing/SKILL.md) | writing web unit tests or checking that a test protects what it claims |
| [`/web-i18n`](.claude/skills/web-i18n/SKILL.md) | adding or changing UI copy or locale keys |
| [`/ui-demo-fidelity`](.claude/skills/ui-demo-fidelity/SKILL.md) | implementing UI from an approved demo |
| [`/product-guide-sync`](.claude/skills/product-guide-sync/SKILL.md) | changing how users operate the canvas, document space, project page or chat panel (the Agent's product guide) |
| [`/editing-agent-rules`](.claude/skills/editing-agent-rules/SKILL.md) | editing any `AGENTS.md`, `CLAUDE.md` or project skill |
