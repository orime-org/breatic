# @breatic/core

The backend shared kernel. These rules apply when you change anything under `packages/core/`.

## Database

### Database code lives in core

**The Drizzle schema, migrations and database clients live only in `src/db/`; worker has no `drizzle-orm` dependency and reaches the database only through `@breatic/domain` repos.** Repos in server, domain and collab all query through core's `db` / `yjsDb`, so a second schema or client elsewhere would split the pool and the migration history.

### Two Postgres databases

**There are two databases: the product database (`db/schema.ts`, `db/migrations/`, clients `db` / `rawPg`) and the Yjs database (`db/yjs-schema.ts`, `db/migrations-yjs/` with its own journal, clients `yjsDb` / `yjsRawPg`, URL `YJS_DATABASE_URL`).** Every migration belongs to exactly one of them, so name which one, and pass `--yjs` to `pnpm db:journal-add` for the Yjs database.

### Migrations are hand-written

**Since `0018` every migration is a hand-written `NNNN_name.sql`; never run `db:generate`.** drizzle-kit's snapshot is frozen at `0017`, so generating diffs `schema.ts` against it and emits every later change again as new.

To add a table or index: write the `.sql` (a partial unique index is written out in full, `CREATE UNIQUE INDEX ... WHERE ...`), run `pnpm db:journal-add <tag>`, then add the `pgTable` definition to `schema.ts`. Index declarations in `schema.ts` are documentation only; the `.sql` is what runs.

### Journal timestamps come from the command

**Add every journal entry with `pnpm db:journal-add <tag>`; never type a `when` by hand.** `drizzle-orm` decides what to run from the newest `created_at` recorded in the database, so a `when` in the future makes every later migration be skipped while `pnpm db:migrate` reports success and exits 0. `repo-lint`'s `migration-journal` check guards the file only.

**A green check does not mean a database will run its migrations.** The database stores each `when` verbatim, so after pulling a journal timestamp correction run `pnpm db:journal-repair` (report) and then `pnpm db:journal-repair --apply` once against every database you have; it rewrites the stored times and runs the migrations that were skipped.

Before renumbering a migration that collided with one already on main, or after merging a migration whose `when` is below the newest one your database has run, invoke `/postgres-drizzle` ([skill](../../.claude/skills/postgres-drizzle/SKILL.md)).

Check: am I about to type a number into a journal? Run the command instead.

### Every table has created_at

**Every table has `created_at timestamp with time zone DEFAULT now() NOT NULL`, with no exemptions.** Entity tables use the `timestamps` helper in `schema.ts` (`created_at` + `updated_at`); append-only history and event tables use `created_at` alone. Tables use UUID primary keys. `breatic/schema-timestamps` enforces this and fails any table whose columns it cannot read.

### Soft delete only

**Rows are never hard-deleted: every table has `deleted_at`, foreign keys are `restrict`, and list queries filter `deleted_at IS NULL`.** Account erasure has its own flow. A table with nothing to soft-delete (append-only ledger, internal queue, one-time credential) goes into `NO_SOFT_DELETE` in `eslint-rules/src/rules/schema-timestamps.ts` with its reason written beside it; an entry without a reason is a violation.
Check: about to add a table to `NO_SOFT_DELETE`? Ask whether its rows go away with their project; project-scoped audit and business rows (activity feed, node history) keep `deleted_at`, and being append-only is not by itself a reason.

### Partial unique indexes cannot use now()

**A partial unique index predicate must be immutable, so it cannot reference `now()`; uniqueness that depends on time ("one live pending invite") is enforced in code before the insert.** An expired row keeps its slot in the index until something moves it to a terminal state, as `expireStalePending` does for studio invites.

### Keep schema.ts imports from shared type-only

**`schema.ts` imports from `@breatic/shared` with `import type` only.** drizzle-kit (`db:generate`, `db:studio`) loads the schema as CommonJS and `@breatic/shared`'s `exports` has no `require` or `main`, so a value import fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` and the error names shared, not `schema.ts`.

Check: am I adding a runtime import to `schema.ts`? Then confirm drizzle-kit still loads it.

### DDL in sql templates needs sql.raw

**In DDL fragments in `schema.ts` (CHECK constraints, defaults), interpolate values with `sql.raw`, never `${value}`.** A `${value}` inside drizzle's `sql` template becomes a bind parameter, and DDL cannot carry parameters.

Check: render the fragment with `new PgDialect().sqlToQuery(...)`; any `$1` means it will break.

## Identity and membership

### Membership limits

**Every tier ceiling is a non-negative integer in `config/membership.yaml` (loader `config/membership.ts`), checked as `count >= limit`; there is no "unlimited" value, so zero means zero.** To leave something uncapped, write a number nobody reaches.

**Code gets ceilings only from the lookups exported by `auth/membership.repo.ts`; a call site never joins the tier and indexes the config itself.** A studio's tier is its current admin's tier and `limitsFor` throws for a tier with no configured limits, so a private join answers from the wrong account or the wrong numbers without an error.

Check: am I about to write a limit number in code? It belongs in that yaml.

### Mutable state reads the current source

**Who owns or administers something is read from `studio_members.role`, never from an audit column such as `studios.created_by_user_id`.** Audit columns record the creator and never change, so after a transfer they still name the previous owner.

Check: can this state change? Then it cannot come from an immutable field.

## Redis

### Redis databases and keys

**Redis is split by database: DB0 sessions, locks and rate limits (`getRedis`); DB1 BullMQ (`getQueueRedis`); DB2 cross-service streams (`getStreamRedis`); DB3 collab instance coordination (`getCollabRedis`).** Keys start with `{env}:` and then their kind (`{env}:session:{token}`, `{env}:stream:task-events`), every key has a TTL, and streams are trimmed to `STREAM_MAXLEN` in `infra/event-stream.ts`.

**Pub/sub channels and the session cookie are separated between deployments on one host only by `REDIS_KEY_PREFIX`.** `SUBSCRIBE` ignores the DB number and a browser shares cookies across ports of one host; the cookie name is built only by `sessionCookieName()` in `infra/session-store.ts`.

Check: is this really separated by DB number or port? Channels and cookie names are not.

### Dedicated Redis connections stay separate

**Subscriber, blocking-read and pub/sub connections each keep their own socket; never merge them to save connections.** Those commands take over the connection by protocol, so sharing one blocks or breaks every other user of it.

### Stream keys

**Cross-service stream keys come only from `taskEventsStreamKey()` and `lifecycleStreamKey()` in `infra/event-stream.ts`.** A hand-built key makes the publisher and the consumer disagree without any error.

## Connections, startup and config

### Connection lifetimes are explicit

**Every Postgres, Redis and queue client sets its idle timeout, lifetime, keepalive and reconnect behaviour explicitly (`idle_timeout` / `max_lifetime` in `db/client.ts`, `keepAlive` / `reconnectOnError` in `infra/redis.ts`).** Client defaults do not recycle idle connections, so a long-running process ends up holding stale ones its pool still thinks are alive.

### Startup checks infrastructure

**Every service calls `checkInfraReady()` (`infra/connectivity-check.ts`) at startup with the Redis clients it uses; it probes both Postgres databases and those clients and throws `InfraNotReadyError`, and the entry exits. Migrations are a separate step that startup never runs.** A service that starts without its infrastructure hangs silently instead of failing.

### Config is injected and read lazily

**The db, Redis, LLM provider and logger singletons build themselves on first use, so the `@breatic/core` barrel can be imported before `initCore` runs.** Every known key, including the health ports (`SERVER_HEALTH_PORT`, `WORKER_HEALTH_PORT`, `COLLAB_HEALTH_PORT`) and `INTERNAL_API_*`, is in the zod schema in `config/schema.ts` and read through `env` or `getConfig()`; keys outside the schema (`PATH`, `HOME`, a provider's `api_key_env`) are read with `getRawEnvVar()`.

### Logger methods need their instance

**Call pino level methods on the logger (`logger.error(...)`); never assign one to a variable and call it bare.** They use `this`, and tests cannot catch the mistake because the default `logger` export is an auto-binding Proxy until `initLogger` swaps in the raw instance that production uses.
