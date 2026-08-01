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
    // One process for this package instead of one per file — rationale and
    // measurements in packages/web/vitest.config.ts, where the effect was
    // largest.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 15_000,
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        // `@opentelemetry/api` rides in as a transitive dependency of the
        // Vercel AI SDK, and its ESM build imports its own files without
        // extensions — which Node's native ESM loader rejects outright when
        // the package is externalised (open-telemetry/opentelemetry-js#3989).
        // The failure lands during collection, so ANY test importing an agent
        // tool could not run at all, which is a large part of why the tools
        // had none. Inlining routes the whole chain through vite instead.
        //
        // Same list as packages/worker/vitest.config.ts, which hit this first.
        inline: [/@opentelemetry/, /node_modules\/ai\//, /@ai-sdk\//],
      },
    },
  },
  resolve: {
    alias: {
      "@domain": resolve(__dirname, "./src"),
    },
  },
});
