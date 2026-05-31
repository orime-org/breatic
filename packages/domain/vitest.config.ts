import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Mirrors @breatic/core's vitest config. The `@domain` alias must match
// tsconfig's `@domain/*` path so vitest resolves the package-internal
// imports the moved source files use (PR4). testTimeout is kept at 15s
// in sync with the other packages so `turbo test` doesn't surface flake.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@domain": resolve(__dirname, "./src"),
    },
  },
});
