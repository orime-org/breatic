/**
 * Vitest global setup for @breatic/core.
 *
 * `@breatic/core` no longer reads `process.env` itself — the
 * application entry (server / worker / collab) injects validated
 * config via `initCore(process.env)` at startup. In tests there is
 * no such entry, so this setup file plays the composition-root role:
 * it loads the developer's `.env` (best-effort) and runs `initCore`
 * once before any test imports library code that reads `env.*`.
 *
 * This file lives OUTSIDE `src/` on purpose: the `lint:no-core-
 * process-env` guard only scans `src/`, and this test harness
 * legitimately reads `process.env` while standing in for the app
 * entry. tsup builds from `src/index.ts`, so this is never bundled.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { initCore, MONOREPO_ROOT } from "@core/config/runtime.js";

// Load the developer's root .env best-effort. Absent in CI (the
// workflow sets DATABASE_URL / SESSION_SECRET_KEY directly), where
// dotenv silently no-ops. Mirrors what config/env.ts did at import
// time before the env-injection refactor.
config({ path: resolve(MONOREPO_ROOT, ".env") });

// Guarantee the two no-default required vars are present so
// initCore's schema validation passes even with neither a .env nor
// CI-provided values. Pure unit tests never open these connections;
// the values only need to satisfy the schema (URL shape + non-empty).
process.env.DATABASE_URL ??= "postgres://localhost:5432/breatic_test";
process.env.SESSION_SECRET_KEY ??= "test-session-secret-key";

initCore(process.env);
