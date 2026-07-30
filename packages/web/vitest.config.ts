import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // One process per package, and one only.
    //
    // Two schedulers sit on top of each other here: turbo starts several
    // packages at once, and each package's vitest starts a batch of its
    // own. Neither knows about the other, so the counts multiply — measured
    // at 37 processes and a load average of 26 on a twelve-core machine,
    // with four people sharing it. What that costs is not theoretical: the
    // bcrypt invariants on the authentication path went from passing to
    // timing out, at random, for no reason anyone could see in the code.
    //
    // This makes the ceiling the number of packages rather than a product
    // of two numbers, so nobody has to multiply anything to know it holds.
    //
    // It is also faster, which was not the expected result: web measured
    // 52s before and 37s after. A worker process pays the whole startup
    // cost again — building a browser environment, collecting files — and
    // for this suite that outweighs what running in parallel wins back.
    //
    // Isolation stays ON. Turning it off was measured too: 76s and 105
    // failures, worse on both counts. The two settings are independent —
    // this one is about how many processes, isolation is about whether
    // state is reset between files.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
