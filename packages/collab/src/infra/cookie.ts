// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Decode the first named Cookie value from a native or standard request header.
 * @param header - The raw Cookie header.
 * @param name - The exact Cookie name to read.
 * @returns Its decoded value, or null when absent.
 * @throws {URIError} When the matching value has malformed URI encoding.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(pair.slice(eq + 1).trim());
  }
  return null;
}
