// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "playwright/test";

/**
 * End-to-end runs of the built client against a running breatic server
 * (`pnpm dev` from the repository root serves one on 8100 by default).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
});
