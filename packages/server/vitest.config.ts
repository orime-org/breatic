import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
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
    // 5s default is too tight for bcrypt-cost-12 + property-based
    // round-trips under turbo parallelism — see
    // packages/core/vitest.config.ts for the full rationale.
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@server": resolve(__dirname, "./src"),
    },
  },
});
