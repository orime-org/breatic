// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { defineConfig, type Options } from "tsup";

/**
 * Everything is bundled except Electron itself, so the packaged app carries no
 * node_modules of its own. Preloads run sandboxed, where only CommonJS loads.
 */
const shared: Options = {
  bundle: true,
  noExternal: [/.*/],
  external: ["electron"],
  sourcemap: true,
  clean: false,
  esbuildOptions(options) {
    options.alias = {
      "@desktop": resolve(import.meta.dirname, "src"),
      "@locales": resolve(import.meta.dirname, "../../locales"),
    };
  },
};

export default defineConfig([
  { ...shared, entry: { "main/index": "src/main/index.ts" }, format: "esm", platform: "node", target: "node22", outDir: "dist", clean: true },
  { ...shared, entry: { "preload/app": "src/preload/app.ts" }, format: "cjs", platform: "node", target: "node22", outDir: "dist", outExtension: () => ({ js: ".cjs" }) },
  { ...shared, entry: { "connect/preload": "src/connect/preload.ts" }, format: "cjs", platform: "node", target: "node22", outDir: "dist", outExtension: () => ({ js: ".cjs" }) },
  {
    ...shared,
    entry: { "connect/connect": "src/connect/connect.ts" },
    format: "iife",
    platform: "browser",
    target: "chrome130",
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
    onSuccess: async () => {
      mkdirSync("dist/connect", { recursive: true });
      copyFileSync("src/connect/index.html", "dist/connect/index.html");
      copyFileSync("src/connect/connect.css", "dist/connect/connect.css");
    },
  },
]);
