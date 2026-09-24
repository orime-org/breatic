// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Words written into a comment box and not sent yet, kept for as long as the
 * editor they belong to (#18, design §9.4 · §9.6).
 *
 * The boxes live in the panel, and the panel is remounted by a Space tab
 * switch; the editor is not — it belongs to the document
 * (`document-editor-cache.ts`). Unsent words are the reader's until they send
 * or clear them, so they are handed over here when a box's words change and
 * read back when the box mounts again.
 *
 * WeakMaps, so nothing here outlives what it is keyed by: a draft's words go
 * with its opening once the draft closes, and a reply's with the editor.
 */

import type { DraftOpening } from '@web/spaces/document/document-comment-draft-range';

/** The words in each open draft, by the opening they were written in. */
const draftWords = new WeakMap<DraftOpening, string>();

/** The words in each thread's reply box, by the editor they belong to. */
const replyWords = new WeakMap<object, ReadonlyMap<string, string>>();

/**
 * What was written in one draft.
 * @param opening - The draft's opening.
 * @returns The words, or an empty string when none were written.
 */
export function keptDraftWords(opening: DraftOpening): string {
  return draftWords.get(opening) ?? '';
}

/**
 * Hands over what is written in one draft.
 * @param opening - The draft's opening.
 * @param words - What is written in it now.
 */
export function keepDraftWords(opening: DraftOpening, words: string): void {
  draftWords.set(opening, words);
}

/**
 * What was written in each reply box.
 * @param editor - The editor the threads belong to.
 * @returns The words by thread id.
 */
export function keptReplies(editor: object): ReadonlyMap<string, string> {
  return replyWords.get(editor) ?? new Map();
}

/**
 * Hands over what is written in each reply box.
 * @param editor - The editor the threads belong to.
 * @param replies - The words by thread id, as they stand now.
 */
export function keepReplies(
  editor: object,
  replies: ReadonlyMap<string, string>,
): void {
  replyWords.set(editor, replies);
}
