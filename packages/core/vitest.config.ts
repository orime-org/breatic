import { defineConfig } from "vitest/config";

// Per CLAUDE.md "服务器端工业级标准" the project tightens
// vitest's default `testTimeout` from 5s to 15s. The 5s default
// is too tight for two project realities:
//
// - bcrypt-cost-12 invariants (auth.service.invariant.test.ts) —
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
  },
});
