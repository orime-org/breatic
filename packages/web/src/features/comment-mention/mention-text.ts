// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The text side of mentioning a member in a comment (#1488 §11.6): which `@`
 * the caret is typing after, putting the picked name in its place, and which
 * mentions still stand when the words are saved. The body stays plain text;
 * the mentioned ids travel beside it.
 */

import type { CommentMention } from '@breatic/shared';

/** An `@` being typed: where it sits and what follows it up to the caret. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** The words typed after it. */
  query: string;
}

/**
 * The `@` the caret is typing after, when there is one: at the start of the
 * text or after whitespace, with no whitespace between it and the caret.
 * @param text - The box's words.
 * @param caret - Where the caret is.
 * @returns The query, or null when the caret is not after such an `@`.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@(\S*)$/.exec(before);
  if (match === null) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

/**
 * Put a picked member's label where the typed `@query` was.
 * @param text - The box's words.
 * @param at - The `@` being typed.
 * @param caret - Where the caret is.
 * @param label - What the mention writes, such as "@Alice".
 * @returns The new words and where the caret goes, just past the label and a space.
 */
export function insertMention(
  text: string,
  at: MentionQuery,
  caret: number,
  label: string,
): { text: string; caret: number } {
  const inserted = `${label} `;
  return {
    text: text.slice(0, at.start) + inserted + text.slice(caret),
    caret: at.start + inserted.length,
  };
}

/**
 * The mentions a comment keeps when its words are saved: each member once,
 * their first mention kept, and only while the text still holds the label
 * the mention wrote or `@` plus their current name, so a rename since does
 * not drop them and deleting the words does.
 * @param text - The words being saved.
 * @param candidates - The mentions it had, then the members picked in this box.
 * @param nameOf - A member's current name, when known.
 * @returns The mentions to store.
 */
export function settleMentions(
  text: string,
  candidates: readonly CommentMention[],
  nameOf: (userId: string) => string | undefined,
): CommentMention[] {
  const kept = new Map<string, CommentMention>();
  for (const m of candidates) {
    if (kept.has(m.userId)) continue;
    const name = nameOf(m.userId);
    if ((m.label !== '' && text.includes(m.label)) || (name !== undefined && name !== '' && text.includes(`@${name}`))) {
      kept.set(m.userId, m);
    }
  }
  return [...kept.values()];
}
