// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The brand a desktop build is made for (inner#2041, design §9.1.1). A brand is a
 * directory holding `brand.json` and its images; the official one is
 * `brands/breatic`, a partner's lives in a private repository and is chosen
 * with BREATIC_BRAND_DIR. stage-app.mjs, electron-builder.config.mjs and
 * tsup.config.ts all read the brand through loadBrand, so every per-brand
 * name is derived in one place.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDesktopAppScheme } from "@breatic/shared";

/** The official brand's directory. */
export const OFFICIAL_BRAND_DIR = join(dirname(fileURLToPath(import.meta.url)), "brands", "breatic");

/** A brand id: the names that must differ between brands on one machine come from it. */
const BRAND_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Quote a path for a desktop entry's Exec key when it holds anything beyond
 * the characters electron-builder leaves bare (LinuxTargetHelper.js).
 * @param path - The executable's path.
 * @returns The path, quoted when needed.
 */
function execPath(path) {
  return /^[/0-9A-Za-z._-]+$/.test(path) ? path : `"${path}"`;
}

/**
 * Read and check a brand.
 * @param {string} dir - The brand directory.
 * @param {Record<string, string | undefined>} env - BREATIC_DEFAULT_SERVER_URL, when non-empty, replaces the server.
 * @returns The brand with every derived name.
 * @throws {Error} when a field is missing or malformed, or an image does not exist.
 */
export function loadBrand(dir, env = process.env) {
  const raw = JSON.parse(readFileSync(join(dir, "brand.json"), "utf8"));
  const fail = (field, why) => {
    throw new Error(`brand ${dir}: ${field} ${why}`);
  };
  if (typeof raw.id !== "string" || !BRAND_ID.test(raw.id)) fail("id", "must be lower-case letters, digits and hyphens");
  if (typeof raw.productName !== "string" || raw.productName.trim() === "") fail("productName", "must be a name");
  if (typeof raw.appId !== "string" || !isDesktopAppScheme(raw.appId.toLowerCase())) fail("appId", "must be a reverse domain name such as ai.breatic.desktop");
  if (typeof raw.serverUrl !== "string") fail("serverUrl", "must be the address of the server the build opens");
  const image = (field) => {
    const path = typeof raw[field] === "string" ? resolve(dir, raw[field]) : "";
    if (!path || !existsSync(path)) fail(field, "must name an image in the brand directory");
    return path;
  };
  const override = env.BREATIC_DEFAULT_SERVER_URL?.trim();
  const productName = raw.productName.trim();
  return {
    id: raw.id,
    productName,
    appId: raw.appId,
    scheme: raw.appId.toLowerCase(),
    serverUrl: override || raw.serverUrl,
    icon: image("icon"),
    logo: image("logo"),
    poweredBy: raw.id !== "breatic",
    packageName: raw.id,
    executableName: raw.id,
    newWindowExec: `${execPath(`/opt/${productName}/${raw.id}`)} --new-window`,
    appImageEntryName: `${raw.id}-appimage.desktop`,
    artifactName: `${raw.id}-\${version}-\${os}-\${arch}.\${ext}`,
  };
}

/**
 * The brand this build is for: BREATIC_BRAND_DIR when set, else the official one.
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns The loaded brand.
 */
export function currentBrand(env = process.env) {
  const dir = env.BREATIC_BRAND_DIR?.trim();
  return loadBrand(dir ? resolve(dir) : OFFICIAL_BRAND_DIR, env);
}
