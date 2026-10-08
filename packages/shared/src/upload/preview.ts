// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a stored image's preview lives (inner#1320, inner#832).
 *
 * Every stored image gets one WebP of at most 576 wide beside it, at a key derived from
 * its own. The derivation is the whole record: nothing in the ledger names the
 * preview, so the Worker that writes it, the backfill that fills it in and
 * every page that shows it read the same rule here.
 */

/** What a preview's key adds to the key of the image it was cut from. */
export const PREVIEW_SUFFIX = ".preview.webp";

/**
 * The tail of a URL path a stored object's key produces: `storageKey` gives
 * `<date>/<ms>_<uuid>.<ext>` and `coverKeyFor` gives the same with `_cover`
 * before the extension. A preview ends in `.png.preview.webp`, which does not
 * fit, so a preview never gets a preview of its own.
 */
const STORED_KEY_TAIL =
  /\/\d{4}-\d{2}-\d{2}\/\d+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:_cover)?\.[A-Za-z0-9]+$/;

/**
 * The key a stored object's preview is written to.
 * @param key - The stored object's key.
 * @returns The preview's key.
 */
export function previewKeyFor(key: string): string {
  return `${key}${PREVIEW_SUFFIX}`;
}

/**
 * The preview address for an image address, when it names a stored object.
 *
 * Only the shape of the address is judged: the page does not know which host
 * the bucket answers on, and nothing else is shaped like a stored key.
 * @param url - An image address as a node or a list holds it.
 * @returns The preview's address, or null for anything that is not a stored
 *   object's address (an external image, a blob, a preview).
 */
export function previewUrlFor(url: string): string | null {
  if (!/^https?:\/\//.test(url)) return null;
  return STORED_KEY_TAIL.test(url) ? `${url}${PREVIEW_SUFFIX}` : null;
}

/**
 * The original image's address for an address that may be its preview.
 * @param url - A preview's address or any other address.
 * @returns The address with the preview suffix removed, or the address as it
 *   was.
 */
export function originalUrlFor(url: string): string {
  return url.endsWith(PREVIEW_SUFFIX)
    ? url.slice(0, -PREVIEW_SUFFIX.length)
    : url;
}
