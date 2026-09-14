// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What we can tell about a source address before anyone fetches it.
 */

/** Anything an extension may be made of, and the longest one worth keeping. */
const SAFE_EXT = /^[A-Za-z0-9]{1,10}$/;

/**
 * The extension to store this source under.
 *
 * Read off the path alone: the commonest shape of an external link is a signed
 * direct URL, whose query string would otherwise land in the storage key — and
 * the key is used as a path, so the public url would then point at a key R2
 * does not hold. Anything but letters and digits falls back for the same
 * reason a filename is screened on the browser's lane: the extension is
 * spliced into the key, and a separator in it invents a segment.
 *
 * It decides nothing about how the object is served — that is the stored
 * content type, which comes from the source's own answer. This only names the
 * file a reader saves.
 * @param url - The address the caller handed us.
 * @returns The dotted extension, or `.bin` when the address suggests none.
 */
export function extFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return ".bin";
  }
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  if (dot < 0) return ".bin";
  const ext = segment.slice(dot + 1);
  return SAFE_EXT.test(ext) ? `.${ext.toLowerCase()}` : ".bin";
}
