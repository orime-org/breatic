// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Unicode tag characters (U+E0000–E007F) taken out of text before a model
 * reads it.
 *
 * They render as nothing, and U+E0020–E007E mirror printable ASCII, so a run
 * of them spells a line no reader sees but a model can still read as words. Their one legitimate use left is the England, Scotland and Wales
 * flags (black flag, tag letters, cancel tag), and those three pass through
 * whole.
 */

/**
 * The three subdivision flags, each kept as one match, or any single tag
 * character on its own. The flags are listed exactly: a black flag followed
 * by any other tag letters is a sequence no platform draws, so its tags go.
 */
const TAGS_OUTSIDE_FLAGS =
  /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * Take the tag characters out of one piece of text.
 * @param text - The text.
 * @returns The same text without tag characters, the three flags kept.
 */
export function stripUnicodeTags(text: string): string {
  return text.replace(TAGS_OUTSIDE_FLAGS, (_match, flag: string | undefined) => flag ?? "");
}
