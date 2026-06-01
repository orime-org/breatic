import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Per CLAUDE.md "industrial-grade server standards" the project tightens
// vitest's default `testTimeout` from 5s to 15s. The 5s default
// is too tight for two project realities:
//
// - bcrypt-cost-12 invariants (auth.service.invariant.test.ts) -
//   each `bcrypt.hash` call is ~500ms on a warm CPU; under turbo
//   parallelism the worker can be CPU-starved and a single hash
//   has been observed to push past 5s. Lowering the cost would
//   violate the security mandate; raising the timeout matches
//   the real-world variance.
// - property-based round-trips (`fast-check`) frequently chain
//   100–1000 iterations and an outlier run can punch through 5s
//   on a noisy runner.
//
// Keep `testTimeout: 15_000` in sync across all packages so the
// `turbo test` aggregate doesn't surface flake-y reds.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    // core no longer reads process.env itself; this setup file
    // stands in for the application entry, loading .env (best-effort)
    // and running initCore(process.env) before any test imports
    // library code that reads env.* through the runtime Proxy.
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@core": resolve(__dirname, "./src"),
    },
  },
});
