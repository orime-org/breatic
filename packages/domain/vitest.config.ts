import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The `@domain` alias must match tsconfig's `@domain/*` path so vitest
// resolves the package-internal imports the source files use.
//
// The timeout is this package's own, not a copy of anyone else's: nothing
// here hashes a password or repeats a property, so a case that runs long
// is a case that is stuck, and the limit should say so quickly. The two
// packages that do pay for bcrypt raise theirs on measured grounds — see
// packages/core/vitest.config.ts.
export default defineConfig({
  test: {
    // One process for this package instead of one per file. Turbo already
    // runs packages in parallel; the second layer of per-file processes is
    // what took a twelve-core machine to 37 processes and a load average of
    // 26, and each of those processes paid the same fixed setup cost over
    // again. Isolation stays on. Measurements are in
    // packages/web/vitest.config.ts, where the effect was largest.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@domain": resolve(__dirname, "./src"),
    },
  },
});
