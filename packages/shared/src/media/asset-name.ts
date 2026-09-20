// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a stored asset is called, read off the address it is stored at.
 *
 * By the time anything reads a node's file it has been uploaded, and its
 * storage key is what it goes by from then on — the key is in the address,
 * and the address is what every lane is handed. So a sentence naming the file
 * that failed does not need a name carried alongside it: the two ends that
 * refuse a reading, the browser and the run, hold the same address and read
 * the same name out of it.
 */

/**
 * The name the asset at this address goes by.
 *
 * The last segment of the path, which for our own keys is
 * `{epoch}_{uuid}{ext}` — minted by `storageKey` and unique to this object.
 * Percent-escapes come off: an address carries the escaped form and a reader
 * is looking at a name.
 * @param url - The address the asset is stored at.
 * @returns The name, or null when the address has no path segment to read.
 */
export function assetNameFromUrl(url: string | undefined | null): string | null {
  if (url === undefined || url === null) return null;
  // Cut the query and the fragment first: a signed address carries both, and
  // neither is part of what the object is called.
  const path = url.split(/[?#]/)[0] ?? "";
  const last = path.split("/").pop() ?? "";
  if (last === "") return null;
  try {
    return decodeURIComponent(last);
  } catch {
    // A stray percent that decodes to nothing valid leaves the escaped form,
    // which still names the object.
    return last;
  }
}
