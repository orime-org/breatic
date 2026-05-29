import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// `testTimeout: 15_000` — see packages/core/vitest.config.ts for the
// 5s → 15s rationale (bcrypt cost-12 + property-based round-trips).
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
// `pnpm --filter @breatic/worker exec vitest run <file>` which
// inherits this config but only loads the requested file.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
