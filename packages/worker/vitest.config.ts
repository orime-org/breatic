import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// `testTimeout: 15_000` — this package's own figure. Nothing here hashes
// a password, so a long-running case here is a stuck one; the packages
// that do pay for bcrypt raise theirs on measured grounds, and the
// reasoning lives in packages/core/vitest.config.ts.
//
// `pool: 'forks'` + `poolOptions.forks.singleFork: true` —
// the worker package runs ~6 ffmpeg-heavy test files
// (video-adjust / video-speed / video-cut / video-hdrConversion /
// video-stabilization / video-sceneExtension / video-audioDenoise)
// that each shell out to ffmpeg. Under vitest's default
// multi-thread pool **and** turbo's cross-package parallelism,
// these ffmpeg invocations contend for CPU and a duration-asserting
// invariant has been observed to drift past its upper bound
// (e.g. video-adjust > "same-duration" got 1.32s vs expected <1.3s,
// see PR `feat/2026-05-27-collab-infra-resilience` commit `5e2faff`
// which widened the tolerance as a workaround). `singleFork: true`
// makes all worker tests run sequentially in one fork — ffmpeg
// invocations no longer race each other inside the package, so the
// tolerance can stay tight and the assertion keeps semantic
// meaning. Turbo still runs other packages in parallel.
//
// Trade-off: worker test wall-clock goes up modestly (each ffmpeg
// test takes 200-500ms and there are ~30 of them, so the upper
// bound is ~15s instead of ~3s parallel). That's acceptable for
// CI; for local dev iteration on a single file, run
// `pnpm build && pnpm --filter @breatic/worker exec vitest run <file>`
// which inherits this config but only loads the requested file. The
// build is not optional: `--filter` skips turbo's dependency graph, so
// without it the run resolves `@breatic/*` from whatever dist happens
// to be on disk.
//
// Every other package now sets the same two options for a different
// reason — the process count under turbo, measured in
// packages/web/vitest.config.ts. Both reasons have to survive any change
// to this policy; this one is specific to ffmpeg contention.
// Domain-import plumbing (#1672) — tests that value-import
// `@worker/providers/shared.js` pull in @breatic/domain (the single model
// config reader). Two pieces make that work under vitest:
// 1. alias @breatic/domain → its SOURCE entry, so tests never depend on a
//    stale dist build and the whole chain goes through vite's resolver;
// 2. inline the Vercel AI SDK (domain's agent chain), so the whole chain is
//    transformed by vite rather than loaded as native Node ESM externals.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    server: {
      deps: {
        inline: [/node_modules\/ai\//, /@ai-sdk\//, /@breatic\/domain/],
      },
    },
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@worker": resolve(__dirname, "./src"),
      "@breatic/domain": resolve(__dirname, "../domain/src/index.ts"),
      "@domain": resolve(__dirname, "../domain/src"),
    },
  },
});
