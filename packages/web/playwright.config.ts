/**
 * Playwright config — minimal headless smoke for the web app.
 *
 * Smoke tests target the running dev server (managed externally —
 * `pnpm dev` from the repo root). The config doesn't spawn a webServer
 * because dev is part of the developer loop, not the test loop, and
 * overlapping vite instances would fight over ports.
 *
 * The port comes from `dev-ports.mts` — the same module `vite.config.mts`
 * uses, so the smoke target cannot drift from the server it is aimed at.
 * That module stays free of `@breatic/shared` on purpose: playwright loads
 * configs through CJS `require()` and shared is ESM-only.
 * That matters once more than one worktree runs `pnpm dev` at a time
 * (#1831): a hard-coded 8000 would silently test a different worktree's
 * frontend.
 */
import { defineConfig, devices } from 'playwright/test';
import { resolveDevPort } from './dev-ports.mjs';

const devPort = resolveDevPort('development', __dirname);
const baseURL = `http://localhost:${devPort}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: {
    // Visual-regression defaults (tests/visual): freeze animations and allow a
    // tiny tolerance for sub-pixel anti-aliasing noise between runs.
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
