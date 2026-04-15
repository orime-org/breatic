/**
 * Type-safe environment variable validation.
 *
 * Uses `@t3-oss/env-core` + Zod to validate all environment variables
 * at import time. The application crashes immediately if required
 * variables are missing or invalid.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

/**
 * Monorepo root directory.
 * env.ts is at packages/server/src/config/ → 4 levels up = root.
 * This is the single source of truth for root path resolution.
 */
export const MONOREPO_ROOT = resolve(import.meta.dirname, "../../../..");

// Load .env from monorepo root (not packages/server/)
config({ path: resolve(MONOREPO_ROOT, ".env") });
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/** Validated environment variables. */
export const env = createEnv({
  server: {
    // ── App ───────────────────────────────────────────
    ENV: z.enum(["dev", "staging", "prod"]).default("dev"),
    DEBUG: z
      .string()
      .default("false")
      .transform((v) => v === "true"),
    PORT: z.coerce.number().int().positive().default(3000),

    // ── Auth ──────────────────────────────────────────
    SESSION_SECRET_KEY: z.string().min(1),
    LOGIN_MODE: z.enum(["WithAccount", "NoAccount"]).default("WithAccount"),

    // ── Database ──────────────────────────────────────
    DATABASE_URL: z.string().url(),
    DB_POOL_SIZE: z.coerce.number().int().positive().default(10),

    // ── Redis ─────────────────────────────────────────
    REDIS_URL: z.string().url().default("redis://localhost:6379/0"),

    // ── CORS ──────────────────────────────────────────
    ALLOWED_ORIGINS: z.string().default("http://localhost:3001"),

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
     * `edit_file`, `list_dir`). Defaults to `<monorepo>/uploads/workspace`.
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
    SMTP_HOST: z.string().default(""),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USER: z.string().default(""),
    SMTP_PASSWORD: z.string().default(""),
  },

  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
});

// ── Startup safety check ─────────────────────────────────────
// NoAccount mode disables ALL authentication. It must never run
// in production — a single misconfigured env var would expose
// every user's data to anonymous access.
if (env.LOGIN_MODE === "NoAccount" && env.ENV === "prod") {
  throw new Error(
    "FATAL: LOGIN_MODE=NoAccount is forbidden when ENV=prod. " +
    "This would disable all authentication. Refusing to start.",
  );
}
