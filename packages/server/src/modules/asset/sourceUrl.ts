// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an upload takes from an address a caller handed over (#207 §7.5).
 *
 * Two things come off it and neither is the address itself: the extension that
 * goes into the storage key, and the name the node's task list shows. The
 * query string belongs to neither — it is where a presigned link carries its
 * signature, and that is a credential rather than a name.
 */

/**
 * Anything an extension may be made of, and the longest one worth keeping.
 *
 * It is spliced into a storage key, which is then used as a path and
 * concatenated into a public URL. A separator in it invents a segment, and a
 * query character in it makes the URL point at a key R2 does not hold — the
 * asset is stored and every reader gets a 404.
 */
const SAFE_EXT = /^[A-Za-z0-9]{1,10}$/;

/**
 * The dotted extension of a name, or `.bin` when it has none we would store.
 *
 * The rule lives here for every lane that puts one in a key. Written twice it
 * is two rules, and the looser of them decides what a reader's URL points at.
 * @param name - A file name or the last segment of a path.
 * @returns The extension with its dot, lowercased, or `.bin`.
 */
export function safeExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return ".bin";
  const ext = name.slice(dot + 1);
  return SAFE_EXT.test(ext) ? `.${ext.toLowerCase()}` : ".bin";
}

/**
 * The extension to store an address's bytes under.
 *
 * Read off the path, so a signed link's `?Expires=…&Signature=…` never reaches
 * the key. It decides nothing a reader sees — the stored type does that — only
 * the name a save-as offers.
 * @param url - The address, as the caller gave it.
 * @returns The extension with its dot, or `.bin`.
 */
export function extFromUrl(url: string): string {
  const path = pathnameOf(url);
  if (path === null) return ".bin";
  return safeExt(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The address as the node's task list shows it.
 *
 * Everything after the path is dropped. A presigned URL's query string is an
 * access token for a third party's origin, and this row is served to every
 * viewer of the project and kept as long as the project is — while what a
 * reader needs from it is which address this task was for.
 * @param url - The address, as the caller gave it.
 * @returns The address without its query string or fragment.
 */
export function labelForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The path of an address, or null when it does not parse.
 * @param url - The address.
 * @returns The pathname, or null.
 */
function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
