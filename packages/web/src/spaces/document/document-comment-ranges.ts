// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where one thread's highlight is, read off the marks (#18, A4 · A6).
 *
 * The library keeps a position table too, and it answers a different
 * question: a thread with more than one mark is merged there into one span
 * from its first start to its last end. That is what you want for hanging a
 * card off a comment — roughly where is it — and it is wrong for quoting one,
 * because an Enter inside a commented run splits the mark in two and
 * everything typed into the gap afterwards falls inside the merged span
 * without carrying the mark.
 *
 * So the two readings are two functions rather than one table read twice.
 *
 * `orphan` is not read here. This answers where a thread's marks are, which
 * is a different question from whether a reader may press them
 * (`document-comment-hit.ts`) — a settled thread still shows the words it was
 * about on its card.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import type { ThreadRange } from '@web/spaces/document/document-comment-state';
import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';


/**
 * Every thread's stretches, from one walk of the body.
 *
 * One walk rather than one per thread: both readers of this module need the
 * answer for every card they are drawing, on every settle — the panel to
 * place them and the cards to quote them — and asking per thread made that N
 * full walks of the document each time.
 * @param doc - The body to walk.
 * @returns Each thread's stretches in document order, by thread id. Threads
 *   whose words are gone are absent rather than empty.
 */
export function threadRangesByThread(
  doc: ProseMirrorNode,
): ReadonlyMap<string, readonly ThreadRange[]> {
  const byThread = new Map<string, ThreadRange[]>();
  doc.descendants((node, pos) => {
    node.marks.forEach((mark) => {
      if (mark.type.name !== COMMENT_MARK) return;
      const threadId = mark.attrs.threadId as string;
      const found = byThread.get(threadId) ?? [];
      if (found.length === 0) byThread.set(threadId, found);
      const from = pos;
      const to = pos + node.nodeSize;
      // Runs next to each other are one stretch as far as a reader is
      // concerned: a bold word inside a commented sentence splits the text
      // into three nodes carrying the same thread.
      const last = found[found.length - 1];
      if (last !== undefined && last.to === from) {
        found[found.length - 1] = { from: last.from, to };
        return;
      }
      found.push({ from, to });
    });
    return true;
  });
  return byThread;
}

/**
 * The words one comment is about.
 *
 * The walk is the caller's: every reader of this module needs the answer for
 * every card it is drawing, so it walks once and quotes from that. Taking the
 * table rather than a document to walk is what keeps a second walk per thread
 * from creeping back in.
 * @param doc - The body the stretches were walked out of.
 * @param threadId - Which thread.
 * @param walked - Every thread's stretches, from one walk of that body.
 * @returns Its words, stretches joined by a space; null once they are gone.
 */
export function threadQuoteIn(
  doc: ProseMirrorNode,
  threadId: string,
  walked: ReadonlyMap<string, readonly ThreadRange[]>,
): string | null {
  const ranges = walked.get(threadId) ?? [];
  if (ranges.length === 0) return null;
  return ranges.map((at) => doc.textBetween(at.from, at.to)).join(' ');
}
