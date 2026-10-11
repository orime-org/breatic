// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The open Space's content as the agent is sent it (inner#1413).
 *
 * The browser cuts it to the limit before sending and the server refuses
 * anything over the limit, so both have to count the same way: in UTF-16 code
 * units, as `messageLength` counts the reader's words.
 */

/** The content kept, and how long it was before it was cut. */
export interface ClippedSpaceContent {
  text: string;
  total: number;
}

/**
 * Keep the first `max` code units of the content.
 *
 * A cut that falls between the two halves of a surrogate pair keeps one fewer,
 * so the text never ends on half a character: some model providers refuse a
 * request carrying a lone surrogate.
 * @param text - The content as read from the Space.
 * @param max - How many code units may be sent.
 * @returns The content kept and its length before the cut.
 * @throws {never} Never.
 */
export function clipSpaceContent(text: string, max: number): ClippedSpaceContent {
  if (text.length <= max) return { text, total: text.length };
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { text: text.slice(0, end), total: text.length };
}
