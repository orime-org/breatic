/**
 * Core configuration schema + pure validator.
 *
 * This module is **pure**: it describes what valid configuration
 * looks like (the Zod schema) and how to validate a raw key/value
 * map into a typed {@link CoreConfig}. It NEVER reads `process.env`
 * or loads a `.env` file — that is configuration ACQUISITION, which
 * belongs to the application layer (server / worker / collab
 * entries = the composition root). The entry reads `process.env`
 * once and hands the raw map to {@link parseConfig}; library code
 * reads the validated result through the accessors in
 * `@core/config/runtime` (the `env` Proxy / `getConfig()`).
 *
 * See CLAUDE.md "core / shared 不读环境变量" mandate — the same
 * "library doesn't make application decisions" principle that bans
 * `logger.*` and `process.exit()` in library code. Plain Zod is
 * used (not `@t3-oss/env-core`) precisely because that library's
 * job is to wire `process.env` into a schema — and the whole point
 * here is to decouple the schema from the `process.env` read.
 */

import { z } from "zod";

/**
 * The core configuration schema. Plain Zod — `.parse()` coerces /
 * applies defaults / strips unknown keys. Blank-string vars keep
 * their `""` value (Zod does not treat `""` as undefined), matching
 * the previous `emptyStringAsUndefined: false` behaviour.
 */
export const coreConfigSchema = z.object({
  // ── App ───────────────────────────────────────────
  ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
  DEBUG: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  PORT: z.coerce.number().int().positive().default(3000),

  // ── Health probe ports (主+1 scheme; one per long-lived service) ──
  // Each long-lived service exposes `GET /healthz` on a dedicated
  // port so probe traffic doesn't touch the main WS / API port.
  // Centralized here (previously each entry read these directly
  // from process.env, bypassing validation).
  SERVER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(9101),
  COLLAB_HEALTH_PORT: z.coerce.number().int().positive().default(1235),

  // ── Auth ──────────────────────────────────────────
  SESSION_SECRET_KEY: z.string().min(1),

  // ── Database ──────────────────────────────────────
  DATABASE_URL: z.string().url(),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(10),

  // ── Redis ─────────────────────────────────────────
  REDIS_URL: z.string().url().default("redis://localhost:6379/0"),
  REDIS_QUEUE_URL: z.string().url().default("redis://localhost:6379/1"),
  REDIS_STREAM_URL: z.string().url().default("redis://localhost:6379/2"),

  // ── CORS ──────────────────────────────────────────
  ALLOWED_ORIGINS: z.string().default("http://localhost:3001"),

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

  /**
   * Sandbox root for the agent file tools (`read_file`, `write_file`,
   * `edit_file`, `list_dir`). Defaults to `<monorepo>/sandbox`.
   * Every tool call is constrained to paths whose realpath is equal
   * to or under this directory.
   */
  FILE_TOOL_SANDBOX_DIR: z.string().default(""),

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
  CREDIT_MULTIPLIER: z.coerce.number().positive().default(1.0),

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
  UPLOAD_MAX_IMAGE_MB: z.coerce.number().positive().default(50),
  UPLOAD_MAX_VIDEO_MB: z.coerce.number().positive().default(1024),
  UPLOAD_MAX_AUDIO_MB: z.coerce.number().positive().default(100),
  UPLOAD_MAX_3D_MB: z.coerce.number().positive().default(200),
  UPLOAD_MAX_DOCUMENT_MB: z.coerce.number().positive().default(20),

  // ── Email ────────────────────────────────────────
  // Mailer backend dispatch — self-host friendly default. See
  // `packages/core/src/infra/mailer.ts:sendMail` for routing.
  //   disabled : noop (no email, returns false). Pair with recovery-code
  //              based password reset for SMTP-less self-hosts.
  //   console  : logs subject + html to server log (dev: lift magic
  //              link / verify token straight out of stdout).
  //   smtp     : dispatch via nodemailer using SMTP_* below. Any SMTP
  //              relay works (self-hosted postfix, Resend, SendGrid,
  //              AWS SES — all expose RFC 5321 SMTP).
  EMAIL_BACKEND: z.enum(["disabled", "console", "smtp"]).default("disabled"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),
});

/** Validated, typed core configuration. */
export type CoreConfig = z.infer<typeof coreConfigSchema>;

/**
 * Validate a raw environment map into a typed {@link CoreConfig}.
 *
 * @param rawEnv - The raw key/value map the application read from
 *   `process.env` (the entry owns the `process.env` read; this
 *   function only processes the map it is handed).
 * @returns The validated, typed, default-applied configuration.
 * @throws ZodError if a required variable is missing / malformed.
 * @throws Error if payments are enabled without Stripe secrets.
 */
export function parseConfig(rawEnv: Record<string, string | undefined>): CoreConfig {
  const config = coreConfigSchema.parse(rawEnv);

  // Startup safety check — Stripe secrets must be present (and
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

  return config;
}
