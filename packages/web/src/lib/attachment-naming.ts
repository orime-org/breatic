// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How long an attachment's own words may run when they stand in for its name
 * in the chat's attachment tray.
 */
const ATTACHMENT_NAME_CHARS = 40;

/**
 * Words cut to the length an attachment name may run, counted in characters.
 * Counting UTF-16 units could cut an emoji in half, and the name is stored in
 * a jsonb column, which refuses a lone surrogate, so the message would fail.
 * @param words - The words.
 * @returns At most the first 40 characters.
 */
export function clipAttachmentName(words: string): string {
  return [...words].slice(0, ATTACHMENT_NAME_CHARS).join('');
}

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
