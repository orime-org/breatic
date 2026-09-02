// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Core configuration schema + pure validator.
 *
 * This module is **pure**: it describes what valid configuration
 * looks like (the Zod schema) and how to validate a raw key/value
 * map into a typed {@link CoreConfig}. It NEVER reads `process.env`
 * or loads a `.env` file - that is configuration ACQUISITION, which
 * belongs to the application layer (server / worker / collab
 * entries = the composition root). The entry reads `process.env`
 * once and hands the raw map to `parseConfig`; library code
 * reads the validated result through the accessors in
 * `@core/config/runtime` (the `env` Proxy / `getConfig()`).
 *
 * See CLAUDE.md "core/shared must not read env vars" mandate - the same
 * "library doesn't make application decisions" principle that bans
 * `logger.*` and `process.exit()` in library code. Plain Zod is
 * used (not `@t3-oss/env-core`) precisely because that library's
 * job is to wire `process.env` into a schema - and the whole point
 * here is to decouple the schema from the `process.env` read.
 */

import { z } from "zod";
import { DEFAULT_API_PORT, DEFAULT_COLLAB_PORT } from "@breatic/shared";

/**
 * Normalise a blank env value to undefined so `.default()` / `.optional()` fire.
 *
 * `.env` files spell an unset var as `VAR=`, and zod keeps that as `""` rather
 * than undefined — so a default never applies and any field-level validation
 * (a numeric coercion, a regex) runs against the empty string and throws. The
 * result is the booby trap where deleting a line works and blanking it crashes.
 *
 * Must be applied as a PREPROCESS, not fixed up afterwards: object-level
 * `.transform()` runs after every field has already been validated, so a field
 * that rejects `""` never reaches it.
 * Also trims: an operator who typed `VAR= dev-agent ` meant `dev-agent`, and
 * the surrounding spaces would otherwise fail the field's own validation.
 * @param v - The raw value from the env map.
 * @returns undefined when blank / whitespace-only, otherwise the trimmed value.
 */
function blankToUndefined(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Wrap a numeric env var so a blank value means "not set".
 *
 * `.env` files spell an unset var as `VAR=`. Zod keeps that as `""` rather than
 * undefined, which means `.default()` never fires and `z.coerce.number()`
 * silently turns `""` into 0 — failing `.positive()` and refusing to boot with
 * "Too small: expected number to be >0", an error that points nowhere near the
 * blank line that caused it. Deleting the line worked, blanking it crashed.
 *
 * Only blank (or whitespace) is forgiven. A garbage value like `abc` still
 * throws: that is a genuine misconfiguration, and quietly booting on the
 * default while the operator believes they set something is worse than a loud
 * failure at startup.
 * The return type is derived from `z.preprocess` rather than spelled out.
 * Naming the shape by hand meant copying a type Zod owns, and 4.4 renamed it
 * (`ZodPipe<ZodTransform<...>, T>` became `ZodPreprocess<T>`) — a rename that
 * broke this line while the runtime behaviour was untouched. Deriving it means
 * the next rename lands here for free.
 * @param schema - The underlying numeric schema (with its own default / bounds).
 * @returns A schema that maps blank input to undefined before parsing.
 */
function numeric<T extends z.ZodTypeAny>(
  schema: T,
): ReturnType<typeof z.preprocess<unknown, T, unknown>> {
  return z.preprocess(blankToUndefined, schema);
}

/**
 * The core configuration schema. Plain Zod - `.parse()` coerces /
 * applies defaults / strips unknown keys.
 *
 * Zod does not treat `""` as undefined, so a blank `VAR=` line reaches
 * the field as an empty string rather than firing its `.default()`.
 * Every numeric field is therefore wrapped in {@link numeric} (and
 * `REDIS_KEY_PREFIX` in the same `blankToUndefined` preprocess), which
 * maps blank / whitespace-only to undefined so the default applies.
 * ADD A NEW NUMERIC FIELD → WRAP IT IN `numeric()`, or `VAR=` will
 * coerce to 0, fail `.positive()`, and refuse to boot with an error
 * that points nowhere near the cause.
 *
 * The other field kinds behave differently, and only the last one is
 * actually forgiving:
 *   - `z.enum(...)` (ENV, STORAGE_PROVIDER, EMAIL_BACKEND) — a blank
 *     value fails the enum and refuses to boot, `.default()` and all.
 *   - `.url()` (REDIS_URL &c.) — same: blank fails URL validation.
 *   - plain `z.string()` (SMTP_HOST, SMTP_USER &c.) — blank is kept as
 *     a deliberate empty string, which is what those fields want.
 * So the "delete the line = fine, blank the line = crash" trap is only
 * closed for numerics; enum and URL fields still carry it. That is a
 * pre-existing gap, not something #1831 introduced — tracked as #1834.
 */
export const coreConfigSchema = z.object({
  // ── App ───────────────────────────────────────────
  ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
  DEBUG: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  PORT: numeric(z.coerce.number().int().positive().default(DEFAULT_API_PORT)),

  // ── Health probe ports (primary+1 scheme; one per long-lived service) ──
  // Each long-lived service exposes `GET /healthz` on a dedicated
  // port so probe traffic doesn't touch the main WS / API port.
  // Centralized here (previously each entry read these directly
  // from process.env, bypassing validation).
  SERVER_HEALTH_PORT: numeric(z.coerce.number().int().positive().default(3001)),
  WORKER_HEALTH_PORT: numeric(z.coerce.number().int().positive().default(9101)),
  COLLAB_HEALTH_PORT: numeric(z.coerce.number().int().positive().default(1235)),
  // Collab's MAIN WebSocket port. Lives here with the other two service ports,
  // NOT in `config/collab.yaml` where it used to sit as a plain key with a
  // schema default. One kind of setting belongs in one place: the other three
  // service ports were already here, and collab's being elsewhere made it the
  // one port unsettable from `.env` — which is what a second worktree needs
  // most (#1831). `collab.yaml` keeps only behaviour knobs (debounce,
  // connection caps, lease budgets).
  COLLAB_PORT: numeric(z.coerce.number().int().positive().default(DEFAULT_COLLAB_PORT)),

  // ── Auth ──────────────────────────────────────────
  // `SESSION_SECRET_KEY` used to be declared (and required) here. Removed
  // 2026-07-27 (#1831): session tokens are opaque `crypto.randomUUID()` values
  // looked up in Redis — nothing ever signed anything, so no code read this
  // variable. A required setting with zero consumers is worse than none: every
  // deployment had to invent a value, and `.env.docker` told operators to
  // change it as if it carried security weight.

  // ── Database ──────────────────────────────────────
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: numeric(z.coerce.number().int().positive().default(10)),

  // ── yjs Database (separate Postgres DB for the Yjs binary store) ──
  // The Yjs document store lives in its OWN database, a separate
  // transaction / failure domain from the business DB (it cannot share
  // a transaction with `projects` etc.). Early-stage this may be a
  // second database on the SAME Postgres instance (different db name);
  // at scale, point `YJS_DATABASE_URL` at a separate instance — just
  // change the URL, no code change (same pattern as REDIS_*_URL).
  YJS_DATABASE_URL: z
    .string()
    .url()
    .default("postgres://breatic:breatic@localhost:5432/breatic_yjs"),
  YJS_DB_POOL_SIZE: numeric(z.coerce.number().int().positive().default(10)),

  // ── Redis ─────────────────────────────────────────
  REDIS_URL: z.string().url().default("redis://localhost:6379/0"),
  REDIS_QUEUE_URL: z.string().url().default("redis://localhost:6379/1"),
  REDIS_STREAM_URL: z.string().url().default("redis://localhost:6379/2"),
  // DB 3: collab cross-instance coordination — Hocuspocus pub/sub +
  // the space-delete serialization lock. Split from REDIS_STREAM_URL
  // (which stays cross-service Streams) so collab-cluster coordination
  // can later move to its own Redis instance by changing only this URL.
  REDIS_COLLAB_URL: z.string().url().default("redis://localhost:6379/3"),

  // Namespace for the two things neither the Redis DB number nor the port
  // split can separate:
  //   1. Redis PUB/SUB CHANNELS — the Hocuspocus document-sync family and the
  //      `project:*` control family (membership changes + Space CRUD).
  //   2. The SESSION COOKIE NAME (`sessionCookieName()`), because cookies are
  //      not scoped by port (RFC 6265 §8.5).
  // Nothing else. Resolved by the transform below: unset or blank means `ENV`.
  //
  // ⚠️ TWO THINGS CHANGE NAME WHEN THIS SHIPS. Both are one-off.
  //   - The session cookie was a fixed `breatic_session` and becomes
  //     `breatic_session_{ENV}`, so every live session stops resolving and
  //     each user signs in once more. No data is touched — the old Redis rows
  //     just age out on their 30-day TTL.
  //   - The CONTROL channels gain a prefix they never had: `project:{id}:…`
  //     becomes `{ENV}:project:{id}:…`. (The Hocuspocus family is unaffected —
  //     it was already `{ENV}:hocuspocus:…`, so its names are unchanged.)
  //     A single-container deploy stops the old build before starting the new
  //     one, so nothing overlaps. But when server or collab runs MULTIPLE
  //     replicas, a rolling update has
  //     old and new instances live at once, and an old publisher's
  //     `project:…` never reaches a new subscriber's `{ENV}:project:*` — pub/sub
  //     drops unmatched publishes with no error. For that window, membership
  //     revocations do not reach collab: a removed member keeps their open
  //     session until the rollout finishes.
  //
  // It exists because pub/sub is the one thing the `REDIS_*_URL` DB split cannot
  // isolate: SUBSCRIBE is instance-wide and ignores the selected DB. Ordinary
  // keys (sessions, locks, BullMQ, streams) are already separated by DB number;
  // channels are not. Two deployments sharing a Redis instance therefore need
  // distinct prefixes here, or each hears the other's document updates and
  // membership writes whenever both hold the same UUID (#1831).
  //
  // Deliberately NOT used for anything Redis keys the DB number already covers:
  //   - cross-service STREAM keys (`taskEventsStreamKey()` etc.) — server,
  //     worker and collab must agree byte-for-byte, so they derive from ENV
  //   - collab's stream CURSOR keys — a cursor must share the namespace of the
  //     stream it points into, and renaming one out from under a running
  //     deployment makes it read as missing, which replays the whole stream
  // Character set is enforced, not cosmetic. The subscriber interpolates this
  // into a PSUBSCRIBE glob while publishers use it literally, so a `*` or `?`
  // in here makes the two sides silently stop agreeing — the pattern matches
  // channels nobody writes and misses the ones they do, with no error. It also
  // becomes part of the session cookie name, where a space / `;` / `,` is
  // illegal. Letters, digits, `-` and `_` only.
  REDIS_KEY_PREFIX: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(
      /^[A-Za-z0-9_-]+$/,
      "REDIS_KEY_PREFIX may contain only letters, digits, '-' and '_' " +
          "(it goes into a Redis PSUBSCRIBE pattern and the session cookie name)",
      )
      .optional(),
  ),

  // ── CORS ──────────────────────────────────────────
  // The browser origin is the VITE DEV SERVER (8000 by default), not a service
  // port. The old default said 3001 — the API's /healthz port, which no browser
  // ever calls from. It sat wrong unnoticed because `.env.dev` sets this
  // explicitly to :8000, and the Docker deployment serves the frontend from the
  // same origin as the API, so neither path ever fell back to the default.
  // Aligned with `.env.dev` (2026-07-27).
  ALLOWED_ORIGINS: z.string().default("http://localhost:8000"),

  // ── Cookie ────────────────────────────────────────
  // Empty string = let the browser scope to the request host
  // (right for dev where the API and web share `localhost`). In
  // prod set a parent domain (e.g. `.thinkai.cc`) when the API
  // and web sit on different subdomains and must share the
  // session cookie.
  COOKIE_DOMAIN: z.string().default(""),

  // ── AI Providers (all optional) ──────────────────
  OPENROUTER_API_KEY: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().default(""),
  GOOGLE_API_KEY: z.string().default(""),
  WAVESPEED_API_KEY: z.string().default(""),
  DASHSCOPE_API_KEY: z.string().default(""),
  BYTEPLUS_API_KEY: z.string().default(""),
  KLINGAI_ACCESS_KEY: z.string().default(""),
  KLINGAI_SECRET_KEY: z.string().default(""),
  MINIMAX_API_KEY: z.string().default(""),
  ELEVENLABS_API_KEY: z.string().default(""),
  FAL_API_KEY: z.string().default(""),
  TOPAZ_API_KEY: z.string().default(""),
  PIXVERSE_API_KEY: z.string().default(""),
  VIDU_API_KEY: z.string().default(""),
  LUMA_API_KEY: z.string().default(""),
  FISH_API_KEY: z.string().default(""),

  // ── Agent Tools ───────────────────────────────────
  BRAVE_SEARCH_API_KEY: z.string().default(""),

  // ── Google OAuth ────────────────────────────────
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  // ── Payment ──────────────────────────────────────
  PAYMENT_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  CREDIT_MULTIPLIER: numeric(z.coerce.number().positive().default(1.0)),

  // ── Storage ──────────────────────────────────────
  STORAGE_PROVIDER: z.enum(["local", "s3", "aliyun_oss"]).default("local"),
  UPLOAD_BASE_URL: z.string().default(""),
  LOCAL_UPLOAD_DIR: z.string().default(""),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default(""),
  S3_ACCESS_KEY: z.string().default(""),
  S3_SECRET_KEY: z.string().default(""),
  OSS_BUCKET: z.string().default(""),
  OSS_ENDPOINT: z.string().default(""),
  OSS_ACCESS_KEY: z.string().default(""),
  OSS_SECRET_KEY: z.string().default(""),

  // ── Upload Size Limits (MB, per asset kind) ─────
  UPLOAD_MAX_IMAGE_MB: numeric(z.coerce.number().positive().default(50)),
  UPLOAD_MAX_VIDEO_MB: numeric(z.coerce.number().positive().default(1024)),
  UPLOAD_MAX_AUDIO_MB: numeric(z.coerce.number().positive().default(100)),
  UPLOAD_MAX_3D_MB: numeric(z.coerce.number().positive().default(200)),
  UPLOAD_MAX_DOCUMENT_MB: numeric(z.coerce.number().positive().default(20)),

  // ── Email ────────────────────────────────────────
  // Mailer backend dispatch - self-host friendly default. See
  // `packages/core/src/infra/mailer.ts:sendMail` for routing.
  //   disabled : noop (no email, returns false). Pair with recovery-code
  //              based password reset for SMTP-less self-hosts.
  //   console  : logs subject + html to server log (dev: lift magic
  //              link / verify token straight out of stdout).
  //   smtp     : dispatch via nodemailer using SMTP_* below. Any SMTP
  //              relay works (self-hosted postfix, Resend, SendGrid,
  //              AWS SES - all expose RFC 5321 SMTP).
  EMAIL_BACKEND: z.enum(["disabled", "console", "smtp"]).default("disabled"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: numeric(z.coerce.number().default(587)),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
  // Where a buyer writes back. It goes into the purchase confirmation, which
  // has to name a way to reach us, and it belongs beside the SMTP settings
  // because a self-hosted deployment answers its own mail.
  SUPPORT_EMAIL: z.string().default(""),
})
  // Resolve `REDIS_KEY_PREFIX` here rather than at each call site: a
  // fallback repeated at every consumer is a fallback that eventually
  // disagrees with itself. Downstream code reads a plain `string`.
  //
  // `??` is safe here ONLY because the field itself already ran through
  // `blankToUndefined` (see the `REDIS_KEY_PREFIX` declaration above), so a
  // blank `VAR=` arrives as undefined rather than `""`. Without that
  // preprocess this would need `||`: `.env` templates spell an unset
  // optional var as `VAR=`, zod keeps `""`, and `?? ` would let it through
  // — silently building channels named `:hocuspocus:…`, isolated from
  // nothing. Blank means unset, and the preprocess is what makes it so.
  .transform((c) => ({
    ...c,
    REDIS_KEY_PREFIX: c.REDIS_KEY_PREFIX ?? c.ENV,
  }));

/** Validated, typed core configuration. */
export type CoreConfig = z.infer<typeof coreConfigSchema>;

/**
 * Validate a raw environment map into a typed {@link CoreConfig}.
 * @param rawEnv - The raw key/value map the application read from
 *   `process.env` (the entry owns the `process.env` read; this
 *   function only processes the map it is handed).
 * @returns The validated, typed, default-applied configuration.
 * @throws {z.ZodError} if a required variable is missing / malformed.
 * @throws {Error} if payments are enabled without Stripe secrets.
 */
export function parseConfig(rawEnv: Record<string, string | undefined>): CoreConfig {
  const config = coreConfigSchema.parse(rawEnv);

  // Startup safety check - Stripe secrets must be present (and
  // non-whitespace) when payments are on. Both default to "" so the
  // app boots with PAYMENT_ENABLED=false; if enabled and empty,
  // webhook signature verification fails confusingly at runtime.
  // Fail fast at init with a clear message instead.
  if (config.PAYMENT_ENABLED) {
    if (!config.STRIPE_SECRET_KEY.trim()) {
      throw new Error(
        "FATAL: PAYMENT_ENABLED=true requires STRIPE_SECRET_KEY to be set " +
        "(non-empty, non-whitespace). Refusing to start.",
      );
    }
    if (!config.STRIPE_WEBHOOK_SECRET.trim()) {
      throw new Error(
        "FATAL: PAYMENT_ENABLED=true requires STRIPE_WEBHOOK_SECRET to be set " +
        "(non-empty, non-whitespace). Refusing to start.",
      );
    }
  }

  // The yjs binary store must be a DIFFERENT database than the business
  // DB — they are separate transaction / failure domains by design (the
  // whole point of the split, and a shared __drizzle_migrations ledger
  // would corrupt if they collided). In dev they may share a Postgres
  // instance (different db name); outside dev a same-database misconfig
  // would silently collapse the split, so fail fast at init.
  if (config.ENV !== "dev") {
    const main = new URL(config.DATABASE_URL);
    const yjs = new URL(config.YJS_DATABASE_URL);
    if (main.host === yjs.host && main.pathname === yjs.pathname) {
      throw new Error(
        "FATAL: YJS_DATABASE_URL must point at a DIFFERENT database than " +
        "DATABASE_URL (same host + database collapses the two-DB split). " +
        "Refusing to start.",
      );
    }
  }

  return config;
}
