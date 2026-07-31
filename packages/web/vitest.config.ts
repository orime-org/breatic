import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    css: true,
    // tests/smoke/ and tests/visual/ are Playwright suites (`pnpm test:smoke`
    // / `pnpm test:visual`); exclude both from vitest so the two runners do not
    // clash on `test()` globals.
    exclude: ['node_modules', 'dist', 'tests/smoke/**', 'tests/visual/**'],
    // See packages/core/vitest.config.ts for the 5s → 15s rationale.
    testTimeout: 15_000,
    // `pool: 'forks'` + `singleFork: true` — one process for the whole
    // package instead of one per file. Measured on a 12-core machine: turbo
    // runs the nine packages that have tests at once and each package's
    // vitest then opened its own batch, which peaked at 37 processes and a
    // load average of 26, saturating the machine. The per-file processes
    // were also paying the same fixed cost over and over: setup 110s → 2.0s,
    // building the jsdom environment 260s → 0.4s, collecting files 63s →
    // 3.9s. Wall clock for this package went 56s → 30s (two runs each), so
    // this is faster as well as cheaper.
    //
    // `isolate` stays on and is load-bearing, but note what it still covers
    // here: vitest builds the jsdom environment once outside the file loop
    // and only resets mocks and the module registry between files
    // (vitest 3's `runBaseTests`), so files share one document — see
    // vitest.setup.ts for what that costs. Modules are still isolated, and
    // that matters: the control run with `--no-isolate` was 59s with 104
    // failures, both slower and wrong.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@web': path.resolve(__dirname, './src'),
      // Mirror vite.config.mts so vitest can resolve `@locales/*.json`
      // imports from src/i18n/locale-bootstrap.ts (and any test that
      // transitively imports it, e.g. via TopBar → LangSwitcher).
      '@locales': path.resolve(__dirname, '../../locales'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
});
