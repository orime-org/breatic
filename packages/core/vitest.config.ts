import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// What a test here may cost in wall-clock time.
//
// The 120s ceiling was raised for tests this package no longer has. The
// bcrypt-at-cost-12 invariants and the property-based round-trips that drove
// it now live in @breatic/server (auth.service.invariant.test.ts,
// recovery-code.service.test.ts), which keeps the same limit and the full
// reasoning. Measured today, the slowest file here takes 2.0s, so nothing in
// this package is near the ceiling.
//
// It stays where it is rather than being tuned down by guess: a limit only
// ever catches a hung test, and picking a new one would need the same kind of
// measurement under CI contention that earned the original. Whoever needs a
// tighter signal here should measure first — the number above is headroom,
// not a claim about this package's tests.
export default defineConfig({
  test: {
    // One process for this package instead of one per file — rationale and
    // measurements in packages/web/vitest.config.ts, where the effect was
    // largest.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 120_000,
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
