// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { defineConfig } from "playwright/test";

/**
 * End-to-end runs of the built client against a running breatic server.
 * Locally that is the worktree's own `pnpm dev` (8100 by default). In CI,
 * as the web consent suite does, the server starts from its build and the web
 * app from a build served by `vite preview`, whose proxy sends `/api` to it.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  forbidOnly: !!process.env.CI,
  webServer: process.env.CI
    ? [
        {
          command: "node packages/server/dist/index.js",
          cwd: "../..",
          url: `http://localhost:${process.env.SERVER_HEALTH_PORT ?? "3001"}/healthz`,
          timeout: 120_000,
        },
        {
          command: "pnpm exec vite build && pnpm exec vite preview --port 8100 --strictPort",
          cwd: "../web",
          url: "http://localhost:8100/login",
          timeout: 300_000,
          // Source maps are uploaded only from release builds.
          env: { ...process.env, VITE_SENTRY_AUTH_TOKEN: "", BROWSER: "none" },
        },
      ]
    : undefined,
});
