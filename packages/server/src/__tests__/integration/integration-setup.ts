/**
 * Per-worker setup file for integration tests (runs in the forked worker process).
 *
 * Applies the container URLs that globalSetup started into process.env
 * BEFORE any module is imported by test files. This is the only place
 * where it's safe to do so — Vitest's setupFiles run before test file
 * modules are evaluated.
 *
 * @breatic/core no longer reads process.env itself; the application
 * entry injects validated config via initCore(process.env). This setup
 * file only *applies* the env vars (container URLs from inject() + the
 * required fixed vars) — it deliberately does NOT import @breatic/core
 * to call initCore here, because the core barrel pulls the `ai` SDK
 * (→ @opentelemetry/api, whose broken ESM build crashes the vitest
 * loader). Each test that exercises real core mocks `ai` first, then
 * calls initCore(process.env) itself (see canvas-native-e2e). Tests
 * that never touch the env Proxy (e.g. v10-schema-invariants, which
 * only uses createTestDb with an explicit URL) need neither.
 */

import { inject } from "vitest";

// Declare the shape of values provided by globalSetup.setup() via provide().
// Vitest uses declaration merging on this interface to type inject() calls.
declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
  }
}

const urls = inject("DATABASE_URL")
  ? {
      DATABASE_URL: inject("DATABASE_URL"),
      REDIS_URL: inject("REDIS_URL"),
      REDIS_QUEUE_URL: inject("REDIS_QUEUE_URL"),
      REDIS_STREAM_URL: inject("REDIS_STREAM_URL"),
    }
  : null;

if (urls) {
  process.env.DATABASE_URL = urls.DATABASE_URL;
  process.env.REDIS_URL = urls.REDIS_URL;
  process.env.REDIS_QUEUE_URL = urls.REDIS_QUEUE_URL;
  process.env.REDIS_STREAM_URL = urls.REDIS_STREAM_URL;
}

// Required env vars that @breatic/core validates at import time.
// ENV must be "dev" | "staging" | "prod" — not "test" (see core/config/env.ts z.enum).
// We use "dev" so that the stream key published by the worker
// (dev:stream:task-events) matches the key the task-listener reads.
process.env.ENV = "dev";
process.env.SESSION_SECRET_KEY = "test-secret-key-for-integration-tests";
process.env.STORAGE_PROVIDER = "local";
process.env.ALLOWED_ORIGINS = "http://localhost:3001";
