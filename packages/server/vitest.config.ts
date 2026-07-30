import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// What a test here may cost in wall-clock time.
//
// Two things in this package are deliberately expensive: bcrypt at cost 12,
// which is slow by design because that is what makes it worth using, and the
// property-based round-trips that repeat it. Their cost is not fixed — it is
// whatever share of a core the worker gets, and `turbo test` runs sixteen
// packages on twelve cores, so that share is well under one.
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
    // One process per package — see packages/web/vitest.config.ts for the
    // measurements behind this. Isolation stays on.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Scan ALL of src/ for unit tests — co-located *.test.ts next to
    // their module (src/modules/*.test.ts, src/infra/*.test.ts) AND the
    // src/__tests__/ suites. This matches the rest of the monorepo
    // (core / worker / collab use vitest's default scan-everywhere);
    // server previously narrowed to src/__tests__/ only, which silently
    // skipped the co-located module tests in CI. Integration tests stay
    // excluded — they run via vitest.integration.config.ts (testcontainers).
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@server": resolve(__dirname, "./src"),
    },
  },
});
