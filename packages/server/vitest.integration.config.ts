/**
 * Vitest configuration for end-to-end integration tests.
 *
 * These tests spin up real PostgreSQL + Redis containers via Testcontainers
 * and therefore run significantly slower than the unit test suite.
 *
 * Run separately with:
 *   pnpm --filter @breatic/server test:integration
 *
 * Intentionally excluded from the default `pnpm test` run so CI
 * latency stays low.
 *
 * Design note on @opentelemetry/api alias:
 *   The Vercel AI SDK (a dep of @breatic/core) imports @opentelemetry/api.
 *   When Vitest forks-mode intercepts module loading, Vite's resolver picks
 *   the "module" condition in @opentelemetry/api's exports map, resolving
 *   to build/esm/index.js — an ESM build that uses bare extension-less
 *   imports that Node.js ESM cannot load.
 *   We redirect @opentelemetry/api to its CJS build via resolve.alias so
 *   Vite serves the CJS version (build/src/index.js) instead.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Absolute path to @opentelemetry/api's CJS build entry.
// Using the .pnpm virtual store path directly — pnpm symlinks all packages
// through the virtual store, so this path is stable for the installed version.
const OPENTELEMETRY_API_CJS = resolve(
  import.meta.dirname,
  "../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/src/index.js",
);

export default defineConfig({
  resolve: {
    alias: {
      // Redirect @opentelemetry/api to its CJS build (build/src/index.js)
      // instead of the broken ESM build (build/esm/index.js).
      "@opentelemetry/api": OPENTELEMETRY_API_CJS,
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        // Add --conditions to Node.js's ESM loader so it does NOT pick up
        // the non-standard "module" condition from @opentelemetry/api's exports.
        // Without this, Node.js 22's ESM loader would apply Vitest's injected
        // conditions (including "module") which resolves to the broken ESM build.
        execArgv: ["--conditions=node"],
      },
    },
  },
});
