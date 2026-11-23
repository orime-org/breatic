// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Publish a release to the brand's update feed (#1599, design §9.3). CI runs
 * it on a `desktop-v{version}` tag after packing, on each platform's runner.
 * Files go to R2 through its S3 API under {R2_UPDATES_PREFIX}/{brand id}/,
 * which BREATIC_UPDATE_BASE_URL serves; the bucket, the domain and the
 * credentials belong to the deployment.
 *
 * Environment: GITHUB_REF_NAME (the tag), R2_UPDATES_BUCKET,
 * R2_UPDATES_PREFIX, R2_UPDATES_ENDPOINT, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY; BREATIC_BRAND_DIR as for the build.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentBrand } from "../brand.mjs";

/** What a release publishes: installers and what updates them. Build logs and folders stay home. */
const PUBLISHED = /\.(dmg|zip|exe|AppImage|deb|blockmap|yml)$/;
/** Update manifests, which name the files above and so go up last. */
const MANIFEST = /^latest.*\.yml$/;

/**
 * The version a release tag publishes.
 * @param {string} tag - The tag, `desktop-v{version}`.
 * @param {string} packageVersion - packages/desktop/package.json's version.
 * @returns {string} The version.
 * @throws {Error} when the tag is not a desktop release tag or names another version.
 */
export function releaseVersion(tag, packageVersion) {
  const match = /^desktop-v(.+)$/.exec(tag);
  if (!match) throw new Error(`publish runs on a desktop-v{version} tag, not ${JSON.stringify(tag)}`);
  if (match[1] !== packageVersion) throw new Error(`tag ${tag} names ${match[1]} but packages/desktop/package.json is ${packageVersion}`);
  return packageVersion;
}

/**
 * The order to upload a release's files in: everything a manifest names first, the manifests last.
 * @param {string[]} files - The release directory's entries.
 * @returns {string[]} The files to upload, in order.
 */
export function publishOrder(files) {
  const published = files.filter((file) => PUBLISHED.test(file) && !file.startsWith("builder-"));
  return [...published.filter((file) => !MANIFEST.test(file)), ...published.filter((file) => MANIFEST.test(file))];
}

/** Settings a publish cannot go without; the feed address is what the packages were built to read. */
const PUBLISH_SETTINGS = ["BREATIC_UPDATE_BASE_URL", "R2_UPDATES_BUCKET", "R2_UPDATES_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

/**
 * The publish settings missing from an environment.
 * @param {Record<string, string | undefined>} env - The environment.
 * @returns {string[]} The names of the missing ones, blank counting as missing.
 */
export function missingPublishSettings(env) {
  return PUBLISH_SETTINGS.filter((name) => !env[name]?.trim());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = process.env;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  releaseVersion(env.GITHUB_REF_NAME ?? "", manifest.version);
  const missing = missingPublishSettings(env);
  if (missing.length > 0) throw new Error(`publish needs ${missing.join(", ")}`);
  const brand = currentBrand(env);
  const prefix = [env.R2_UPDATES_PREFIX?.replace(/^\/+|\/+$/g, ""), brand.id].filter(Boolean).join("/");
  const release = join(root, "release");
  for (const file of publishOrder(readdirSync(release))) {
    execFileSync(
      "aws",
      ["s3", "cp", join(release, file), `s3://${env.R2_UPDATES_BUCKET}/${prefix}/${file}`, "--endpoint-url", env.R2_UPDATES_ENDPOINT],
      { stdio: "inherit" },
    );
  }
}
