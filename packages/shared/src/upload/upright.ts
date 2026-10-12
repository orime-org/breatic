// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a picture turned upright is stored (inner#1367).
 *
 * A picture with an EXIF orientation is turned upright at upload, and the
 * upright picture is the asset; the bytes as received stay at the ticket's
 * key. The upright one sits beside them, named the way a cover is: a marker
 * before the extension. Taking `_upright` off again names the original.
 */

/** The upright copy as the ingest Worker answers it at a finish. */
export interface UprightCopy {
  storageKey: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

/** The marker an upright picture's key carries before its extension. */
const UPRIGHT_KEY_MARKER = "_upright";

/**
 * The key a stored picture's upright copy is written to.
 * @param key - The key the picture was received under.
 * @returns The same key with `_upright` before the extension.
 */
export function uprightKeyFor(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  const dot = key.indexOf(".", lastSlash + 1);
  return dot === -1
    ? `${key}${UPRIGHT_KEY_MARKER}`
    : `${key.slice(0, dot)}${UPRIGHT_KEY_MARKER}${key.slice(dot)}`;
}
