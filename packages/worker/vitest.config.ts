import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// `testTimeout: 15_000` — this package's own figure. Nothing here hashes
// a password, so a long-running case here is a stuck one; the packages
// that do pay for bcrypt raise theirs on measured grounds, and the
// reasoning lives in packages/core/vitest.config.ts.
//
// `pool: 'forks'` + `poolOptions.forks.singleFork: true` — every package
// sets these two options for the process count under turbo, measured in
// packages/web/vitest.config.ts. For a local run of a single file,
// `pnpm build && pnpm --filter @breatic/worker exec vitest run <file>`
// inherits this config but only loads the requested file. The build is not
// optional: `--filter` skips turbo's dependency graph, so without it the run
// resolves `@breatic/*` from whatever dist happens to be on disk.
// Domain-import plumbing (#1672) — tests that value-import
// `@worker/providers/shared.js` pull in @breatic/domain (the single model
// config reader). Two pieces make that work under vitest:
// 1. alias @breatic/domain → its SOURCE entry, so tests never depend on a
//    stale dist build and the whole chain goes through vite's resolver;
// 2. inline @breatic/domain, so the alias above applies to it rather than
//    being bypassed by a native Node ESM import of the built package.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    server: {
      deps: {
        inline: [/@breatic\/domain/],
      },
    },
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@worker": resolve(__dirname, "./src"),
      "@breatic/domain": resolve(__dirname, "../domain/src/index.ts"),
      "@domain": resolve(__dirname, "../domain/src"),
    },
  },
});
