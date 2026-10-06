// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Words written into a comment box and not sent yet, kept for as long as the
 * editor they belong to (#18, design §9.4.1 · §9.6).
 *
 * This is the one place those words are held. The boxes live in the panel,
 * which can be mounted again (StrictMode mounts it twice); the editor
 * does not go with it — it belongs to the document
 * (`document-editor-cache.ts`) — so the boxes read
 * and write here and keep nothing of their own. Unsent words are the reader's
 * until they send or clear them.
 *
 * WeakMaps, so nothing here outlives what it is keyed by: a draft's words go
 * with its opening once the draft closes, and the replies with the editor.
 */

import type { DraftOpening } from '@web/spaces/document/document-comment-draft-range';

/** The words in each open draft, by the opening they were written in. */
const draftWords = new WeakMap<DraftOpening, string>();

/** The words in each thread's reply box, by the editor they belong to. */
const replyWords = new WeakMap<object, ReadonlyMap<string, string>>();

/** An empty set of replies, handed out whole so it reads as unchanged. */
const NO_REPLIES: ReadonlyMap<string, string> = new Map();

/** Everyone reading from here, told of every change. */
const listeners = new Set<() => void>();

/** Tells every reader something here changed. */
function changed(): void {
  for (const listener of listeners) listener();
}

/**
 * Hear about every change to the unsent words.
 * @param listener - Called after each change.
 * @returns Stop listening.
 */
export function onUnsentChange(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * What is written in one draft.
 * @param opening - The draft's opening.
 * @returns The words, or an empty string when none were written.
 */
export function draftWordsOf(opening: DraftOpening): string {
  return draftWords.get(opening) ?? '';
}

/**
 * Writes what is in one draft.
 * @param opening - The draft's opening.
 * @param words - What is written in it now.
 */
export function writeDraftWords(opening: DraftOpening, words: string): void {
  if (draftWordsOf(opening) === words) return;
  draftWords.set(opening, words);
  changed();
}

/**
 * What is written in each reply box.
 * @param editor - The editor the threads belong to.
 * @returns The words by thread id; the same map until one of them changes.
 */
export function repliesOf(editor: object): ReadonlyMap<string, string> {
  return replyWords.get(editor) ?? NO_REPLIES;
}

/**
 * Writes what is in one thread's reply box; an empty box drops its entry.
 * @param editor - The editor the thread belongs to.
 * @param threadId - The thread.
 * @param words - What is written in its reply box now.
 */
export function writeReply(
  editor: object,
  threadId: string,
  words: string,
): void {
  const held = repliesOf(editor);
  if ((held.get(threadId) ?? '') === words) return;
  const next = new Map(held);
  if (words === '') next.delete(threadId);
  else next.set(threadId, words);
  replyWords.set(editor, next);
  changed();
}

/**
 * Keeps only the replies whose threads are still in the document.
 * @param editor - The editor the threads belong to.
 * @param live - The ids of every thread that still exists.
 */
export function keepRepliesOf(editor: object, live: ReadonlySet<string>): void {
  const held = repliesOf(editor);
  const kept = [...held].filter(([id]) => live.has(id));
  if (kept.length === held.size) return;
  replyWords.set(editor, new Map(kept));
  changed();
}

/**
 * Throws every reply box's words away, which closing the panel does (§9.6).
 * @param editor - The editor the threads belong to.
 */
export function clearReplies(editor: object): void {
  if (repliesOf(editor).size === 0) return;
  replyWords.set(editor, NO_REPLIES);
  changed();
}
