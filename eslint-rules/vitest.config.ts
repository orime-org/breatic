// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One process per package — see packages/web/vitest.config.ts for the
    // measurements behind this. Isolation stays on.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    setupFiles: ["./vitest.setup.ts"],
  },
});
