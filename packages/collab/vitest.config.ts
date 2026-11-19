import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// 15s rather than vitest's 5s default: under turbo's cross-package
// parallelism a test gets well under one core, and the 5s default was
// failing @breatic/server's bcrypt invariant that passes in ~0.5s alone
// (b35ae386). Raised everywhere so one package's contention does not
// decide another's limit.
// The size-cap suites build documents of 200 000 values 3000 levels deep and
// 3 MB of pending structs, and leave the shared fork's heap at 1-2 GB; a file
// that ran after them there took 10 to 20 times as long (frame-assembler's
// AP01: 0.8s alone, 19s after them). vitest starts each project in a fork of
// its own, so they run apart from the rest.
const SIZE_CAP_TESTS = [
  "src/__tests__/document-size-hooks.test.ts",
  "src/__tests__/document-size-pending-hooks.test.ts",
  "src/services/__tests__/document-size.property.test.ts",
];

export default defineConfig({
  test: {
    // One process for this package instead of one per file — rationale and
    // measurements in packages/web/vitest.config.mts, where the effect was
    // largest.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 15_000,
    // Integration suites are excluded here and run via
    // vitest.integration.config.ts. They hold a real server open for real
    // seconds — the ping-interval measurement waits out two 30s periods — and
    // `pnpm test` runs every package at once, so leaving them in makes every
    // other package's suite decide its timeouts on a busier machine.
    // Each project lists its own files: `extends` adds a project's include
    // to the root's, so a root include would put every file in both.
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.integration.test.ts", ...SIZE_CAP_TESTS] } },
      { extends: true, test: { name: "size-cap", include: SIZE_CAP_TESTS } },
    ],
  },
  resolve: {
    alias: {
      "@collab": resolve(__dirname, "./src"),
    },
  },
});
