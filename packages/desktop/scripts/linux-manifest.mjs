// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One Linux update manifest for two packing runs (inner#2041, design §9.1.2). The
 * AppImage and the deb are packed separately, so the deb's package-type
 * marker never lands in the AppImage, and each run writes its own
 * latest-linux.yml. electron-updater's AppImage and deb updaters read the same
 * manifest and pick their file by extension, so the release publishes one
 * that lists both.
 */

import { Document, Scalar, parse } from "yaml";

/**
 * Merge the AppImage run's manifest with the deb run's.
 * @param {string} appImage - The AppImage run's latest-linux.yml.
 * @param {string} deb - The deb run's latest-linux.yml.
 * @returns {string} One manifest listing both files, the AppImage as the default.
 * @throws {Error} when the two runs built different versions.
 */
export function mergeLinuxManifests(appImage, deb) {
  const first = parse(appImage);
  const second = parse(deb);
  if (first.version !== second.version) throw new Error(`latest-linux.yml version differs: ${first.version} and ${second.version}`);
  const urls = new Set(first.files.map((file) => file.url));
  const merged = new Document({ ...first, files: [...first.files, ...second.files.filter((file) => !urls.has(file.url))] });
  // Quoted like electron-builder's own output: electron-updater reads the
  // manifest with js-yaml, which turns a bare ISO date into a Date.
  const releaseDate = merged.get("releaseDate", true);
  if (releaseDate instanceof Scalar) releaseDate.type = Scalar.QUOTE_SINGLE;
  return merged.toString();
}
