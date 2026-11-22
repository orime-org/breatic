// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pack the staged app for the platforms named on the command line (--mac,
 * --win, --linux; the current one when none). Linux packs the AppImage and
 * the deb in separate runs: the deb run writes resources/package-type into
 * the unpacked app it packs, and an AppImage carrying that marker would
 * update itself as a deb (design §9.1.2). The two runs' manifests are merged
 * into release/latest-linux.yml.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLinuxManifests } from "./linux-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = join(root, "release");
const requested = process.argv.slice(2).filter((arg) => ["--mac", "--win", "--linux"].includes(arg));
const platforms = requested.length > 0 ? requested : [{ darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform]];

/**
 * Run electron-builder.
 * @param {string[]} args - Its arguments after the config.
 */
function build(args) {
  execFileSync("npx", ["electron-builder", "--config", "electron-builder.config.mjs", ...args], { cwd: root, stdio: "inherit" });
}

for (const platform of platforms.filter((name) => name !== "--linux")) build([platform]);

if (platforms.includes("--linux")) {
  const runs = { AppImage: join(release, "linux-appimage"), deb: join(release, "linux-deb") };
  for (const [target, output] of Object.entries(runs)) {
    rmSync(output, { recursive: true, force: true });
    build(["--linux", target, "--x64", `-c.directories.output=${output}`]);
  }
  const marker = join(runs.AppImage, "linux-unpacked", "resources", "package-type");
  if (existsSync(marker)) throw new Error(`the AppImage run carries ${marker}; it would update itself as a deb`);
  for (const output of Object.values(runs)) {
    for (const name of readdirSync(output)) {
      if (/\.(AppImage|deb|blockmap)$/.test(name)) copyFileSync(join(output, name), join(release, name));
    }
  }
  const manifests = Object.values(runs).map((output) => join(output, "latest-linux.yml"));
  if (manifests.every((path) => existsSync(path))) {
    writeFileSync(join(release, "latest-linux.yml"), mergeLinuxManifests(readFileSync(manifests[0], "utf8"), readFileSync(manifests[1], "utf8")));
  }
}
