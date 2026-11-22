// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lay out what electron-builder packs (#1599). The build bundles every
 * dependency except Electron, so the app directory holds only the built files
 * and a manifest naming no dependencies: electron-builder then collects no
 * node_modules, which it cannot do from a pnpm workspace anyway. The
 * manifest's name and productName are the brand's: Electron derives the data
 * directory and the single-instance lock from them, and electron-builder the
 * Debian package name and the updater cache (design §9.1.1).
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBrand } from "../brand.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "build", "app");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const brand = currentBrand();

rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(join(root, "dist"), join(app, "dist"), { recursive: true });
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: brand.packageName,
      productName: brand.productName,
      version: manifest.version,
      description: manifest.description,
      author: "Orime, Inc.",
      license: "AGPL-3.0-only",
      // The Debian package requires a homepage.
      homepage: "https://github.com/orime-org/breatic",
      main: "dist/main/index.cjs",
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`staged ${brand.id} in ${app}\n`);
