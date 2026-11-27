// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    // One process for the package, as in every other package (see packages/web/vitest.config.mts).
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
    include: ["src/**/*.test.ts"],
  },
  // The build writes the brand in (tsup.config.ts); tests run as the official one.
  define: {
    __BRAND__: JSON.stringify({ id: "breatic", productName: "breatic", scheme: "ai.breatic.desktop", serverUrl: "", poweredBy: false, splashLogo: "brand-logo.svg", appImageEntryName: "breatic-appimage.desktop" }),
    __BUILD__: JSON.stringify({ sentryDsn: "", commit: "unknown" }),
  },
  resolve: {
    alias: {
      "@desktop": resolve(import.meta.dirname, "src"),
      "@locales": resolve(import.meta.dirname, "../../locales"),
    },
  },
});
