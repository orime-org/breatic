// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long an attachment's own words may run when they stand in for its name
 * in the chat's attachment tray.
 */
export const ATTACHMENT_NAME_CHARS = 40;

/**
 * A short stable hash of some strings, whatever their order. Attachment ids
 * are built from it, so adding the same thing again replaces its item.
 * @param parts - The strings.
 * @returns The hash, base 36.
 */
export function hashOf(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const ch of [...parts].sort().join('\u0000')) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
