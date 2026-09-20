/**
 * Playwright config — the smoke and visual suites for the web app.
 *
 * Both suites target the running dev server (managed externally —
 * `pnpm dev` from the repo root). The config doesn't spawn a webServer
 * because dev is part of the developer loop, not the test loop, and
 * overlapping vite instances would fight over ports.
 *
 * The port comes from `dev-ports.mts` — the same module `vite.config.mts`
 * uses, so the target cannot drift from the server it is aimed at.
 * That module stays free of `@breatic/shared` on purpose: playwright loads
 * configs through CJS `require()` and shared is ESM-only.
 * That matters once more than one worktree runs `pnpm dev` at a time
 * (#1831): a hard-coded 8000 would silently test a different worktree's
 * frontend.
 */
import { defineConfig, devices } from 'playwright/test';
import { resolveDevPort } from './dev-ports.mjs';
import { STATE_FILE } from './tests/helpers/project';

const devPort = resolveDevPort('development', __dirname);
const baseURL = `http://localhost:${devPort}`;

/**
 * The rendering the visual baselines were taken under.
 *
 * `tests/visual/` holds screenshots committed to the repo. This descriptor
 * decides the viewport, the device pixel ratio and the user agent they were
 * captured with, so every project keeps it — a project that dropped it would
 * be comparing against pictures of a different browser.
 */
const chrome = { ...devices['Desktop Chrome'] };

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
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      teardown: 'teardown',
      use: chrome,
    },
    {
      name: 'teardown',
      testMatch: /.*\.teardown\.ts/,
      use: chrome,
    },
    {
      name: 'smoke',
      testDir: './tests/smoke',
      dependencies: ['setup'],
      // Each case builds its own opening rather than sharing one across the
      // file, and the heaviest opening — a Space plus two live collab
      // connections — is measured at over 30s on its own. The budget covers
      // that plus the case itself. Measured per case once the split lands;
      // this figure is the old per-file budget (120s) plus that opening.
      timeout: 180_000,
      use: { ...chrome, storageState: STATE_FILE.A },
    },
    {
      // Named `chromium` because the committed screenshot baselines carry the
      // project name in their filenames (`login-dark-chromium-darwin.png`).
      name: 'chromium',
      testDir: './tests/visual',
      dependencies: ['setup'],
      // The same budget as the suite next door, for the same reason: a case
      // here opens a Space of its own before it measures anything.
      timeout: 180_000,
      use: { ...chrome, storageState: STATE_FILE.A },
    },
  ],
});
