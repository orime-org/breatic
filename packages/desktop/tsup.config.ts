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
  // Electron is the runtime and must stay an import; noExternal wins over
  // external in tsup, so the pattern itself leaves it out.
  noExternal: [/^(?!electron$).*/],
  external: ["electron"],
  sourcemap: true,
  clean: false,
  define: { __DEFAULT_SERVER_URL__: JSON.stringify(process.env.BREATIC_DEFAULT_SERVER_URL ?? "") },
  esbuildOptions(options) {
    options.alias = {
      "@desktop": resolve(import.meta.dirname, "src"),
      "@locales": resolve(import.meta.dirname, "../../locales"),
    };
  },
};

export default defineConfig([
  // CommonJS: bundled CommonJS dependencies (pino) require Node built-ins at
  // runtime, which an ES module bundle cannot do.
  { ...shared, entry: { "main/index": "src/main/index.ts" }, format: "cjs", platform: "node", target: "node22", outDir: "dist", outExtension: () => ({ js: ".cjs" }), clean: true },
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
