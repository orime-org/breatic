import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// What a test here may cost in wall-clock time.
//
// Two things in this package are deliberately expensive: bcrypt at cost 12,
// which is slow by design because that is what makes it worth using, and the
// property-based round-trips that repeat it. Their cost is not fixed — it is
// whatever share of a core the worker gets, and `turbo test` runs the nine
// packages that have tests on twelve cores, so that share can fall under one.
//
// Measured rather than guessed, because this limit has already been too low
// once: a single `verify` takes 0.49s idle and was observed at 3.63s under a
// full parallel run, and the twenty-iteration property goes from 9.7s to past
// the thirty seconds it was allowed. That is a factor of seven on this
// machine; CI runners have fewer cores than this one, so the real worst case
// is worse. Twelve times the idle cost leaves room for that without letting
// something genuinely hung sit here for an hour.
//
// Lowering the bcrypt cost instead would violate the security mandate, and
// dropping iterations would weaken an invariant on the authentication path.
// The limit is the thing that was wrong, so the limit is what changes.
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
