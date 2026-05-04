/**
 * Vitest configuration for integration tests.
 *
 * Separate from vitest.config.ts (unit tests) — integration tests:
 *   - require real Docker containers (PostgreSQL + Redis via testcontainers)
 *   - take 30–120 seconds to run (container boot + migration + E2E flow)
 *   - must NOT run as part of the default `pnpm test` CI step
 *
 * Run with: pnpm --filter @breatic/server test:integration
 *
 * Resolution notes:
 *   @opentelemetry/api@1.9.0's ESM build (build/esm/index.js) uses bare relative
 *   imports (e.g. './baggage/utils') that Node.js native ESM rejects because they
 *   lack the required .js extension. We alias @opentelemetry/api directly to its
 *   CJS build (build/src/index.js) which uses proper require() calls and works fine.
 *   The ai package's ESM build imports @opentelemetry/api so it also picks up this
 *   alias automatically. This only affects the integration test runner — production
 *   code is bundled by tsup separately.
 *
 *   pnpm strict isolation means @opentelemetry/api is not directly resolvable from
 *   this package — we must locate it in the pnpm content-addressable store under
 *   node_modules/.pnpm/@opentelemetry+api@<version>/.
 */

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";

// Monorepo root is two levels up from packages/server/
const MONOREPO_ROOT = resolve(__dirname, "../..");
const PNPM_STORE = resolve(MONOREPO_ROOT, "node_modules/.pnpm");

// Find @opentelemetry/api in the pnpm store (any version, take the first match).
const otelEntry = readdirSync(PNPM_STORE).find((d) =>
  d.startsWith("@opentelemetry+api@"),
);
if (!otelEntry) {
  throw new Error(
    "[vitest.integration.config] Cannot find @opentelemetry/api in pnpm store. " +
      "Run `pnpm install` from the monorepo root first.",
  );
}
// Point at the CJS build which uses require() and works with Node.js native ESM via
// Vite's alias — the ESM build uses extensionless bare imports that Node rejects.
const otelApiCjs = resolve(
  PNPM_STORE,
  otelEntry,
  "node_modules/@opentelemetry/api/build/src/index.js",
);

export default defineConfig({
  test: {
    globals: true,
    include: ["src/__tests__/integration/**/*.integration.test.ts"],
    // globalSetup starts testcontainers BEFORE any test module is imported.
    globalSetup: ["./src/__tests__/integration/global-setup.ts"],
    // setupFiles runs inside the worker process. Re-applies env vars from globalSetup.
    setupFiles: ["./src/__tests__/integration/integration-setup.ts"],
    // Single fork: one worker process, one container set, no port conflicts.
    // pool:"forks" is required for server.deps.inline to take effect —
    // in "threads" mode, Node.js native ESM import() bypasses Vite's transform
    // and inline cannot intercept the broken @opentelemetry/api ESM build.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Long timeout: testcontainers + migration + BullMQ job execution
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // server.deps.inline makes Vite bundle these packages instead of loading
    // them as native Node.js ESM externals. This fixes:
    //   @opentelemetry/api@1.9.0 — ESM build uses bare relative imports that Node.js
    //   native ESM rejects (e.g. './baggage/utils' without .js extension).
    //   ai — imports @opentelemetry/api from its ESM build.
    server: {
      deps: {
        inline: [/@opentelemetry\/api/, /^ai$/],
      },
    },
  },
  resolve: {
    // Exclude the "module" condition so that @opentelemetry/api resolves to
    // its "default" export (build/src/index.js, CJS) instead of the "module"
    // export (build/esm/index.js, ESM with broken bare imports). Vite normally
    // adds "module" to resolve conditions, which picks up the broken ESM build.
    conditions: ["node", "require", "default"],
    alias: {
      "@": resolve(__dirname, "./src"),
      // Force @opentelemetry/api to its CJS build (build/src/index.js).
      // The ESM build (build/esm/index.js) uses bare relative imports without
      // .js extensions (e.g. './baggage/utils') that Node.js native ESM rejects.
      "@opentelemetry/api": otelApiCjs,
      // Allow integration tests to import from worker and collab source directly.
      "@breatic/worker/src": resolve(__dirname, "../worker/src"),
      "@breatic/collab/src": resolve(__dirname, "../collab/src"),
    },
  },
  ssr: {
    // Exclude the "module" condition in SSR mode as well.
    // Vitest runs tests in SSR context; ssr.resolve.conditions overrides
    // the top-level resolve.conditions for SSR execution.
    resolve: {
      conditions: ["node", "require", "default"],
    },
    // Do not externalize any packages — let Vite transform everything so that
    // the resolve.conditions and alias settings apply uniformly.
    noExternal: true,
  },
  optimizeDeps: {
    // Disable dep optimization for integration tests — pre-bundling uses
    // Vite's client-side conditions ("module" etc.) which picks up the
    // broken @opentelemetry/api ESM build.
    disabled: true,
    exclude: ["@opentelemetry/api", "ai"],
  },
});
