// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { extname, resolve } from "node:path";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { defineConfig, type Options } from "tsup";
import { currentBrand } from "./brand.mjs";
import { builtInServerUrl } from "./src/main/server-config.js";
import { buildTimeCommit, buildTimeSentryDsn } from "./src/main/error-monitoring.js";

/** Tagged CI and partner pipelines: the build must carry what error monitoring needs. */
const RELEASE_BUILD = process.env.BREATIC_RELEASE_BUILD === "1";
/** The brand this build is for: BREATIC_BRAND_DIR, else the official one. */
const brand = currentBrand();
/** The brand logo's file name beside the splash page; main reads the extension from the brand too. */
const SPLASH_LOGO = "brand-logo";

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
  define: {
    __BRAND__: JSON.stringify({
      id: brand.id,
      productName: brand.productName,
      scheme: brand.scheme,
      serverUrl: builtInServerUrl(brand.serverUrl),
      poweredBy: brand.poweredBy,
      splashLogo: `${SPLASH_LOGO}${extname(brand.logo)}`,
      appImageEntryName: brand.appImageEntryName,
    }),
    // A release build (tagged CI, partner pipeline) sets BREATIC_RELEASE_BUILD=1 and must carry the DSN and its commit.
    __BUILD__: JSON.stringify({
      sentryDsn: buildTimeSentryDsn(process.env.BREATIC_DESKTOP_SENTRY_DSN, { release: RELEASE_BUILD }),
      commit: buildTimeCommit(process.env.GITHUB_SHA, { release: RELEASE_BUILD }),
    }),
  },
  esbuildOptions(options) {
    options.alias = {
      "@desktop": resolve(import.meta.dirname, "src"),
      "@locales": resolve(import.meta.dirname, "../../locales"),
    };
  },
};

// Cleared once here: tsup builds the configurations below in parallel, so a
// per-configuration clean could delete another one's output.
rmSync(resolve(import.meta.dirname, "dist"), { recursive: true, force: true });

export default defineConfig([
  // CommonJS: bundled CommonJS dependencies (pino) require Node built-ins at
  // runtime, which an ES module bundle cannot do. CommonJS is not split, so each entry stays whole.
  {
    ...shared,
    entry: { "main/index": "src/main/index.ts", "preload/app": "src/preload/app.ts" },
    format: "cjs",
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    ...shared,
    entry: { "splash/splash": "src/splash/splash.ts" },
    format: "iife",
    platform: "browser",
    target: "chrome130",
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
    // The page, the brand's logo and the platform's mark for the attribution line.
    onSuccess: async () => {
      mkdirSync("dist/splash", { recursive: true });
      copyFileSync("src/splash/index.html", "dist/splash/index.html");
      copyFileSync("src/splash/splash.css", "dist/splash/splash.css");
      copyFileSync(brand.logo, `dist/splash/${SPLASH_LOGO}${extname(brand.logo)}`);
      copyFileSync(resolve(import.meta.dirname, "../web/public/logo-color.svg"), "dist/splash/powered-mark.svg");
    },
  },
]);
