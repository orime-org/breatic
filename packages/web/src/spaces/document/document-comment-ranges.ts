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

/** The mark's name on the schema, as the library registers it. */
const COMMENT_MARK = 'comment';

/**
 * Every stretch of body one thread's highlight covers, in document order.
 * @param doc - The body to walk.
 * @param threadId - Which thread.
 * @returns Its stretches, empty once the words are gone.
 */
export function threadRangesIn(
  doc: ProseMirrorNode,
  threadId: string,
): readonly ThreadRange[] {
  const found: ThreadRange[] = [];
  doc.descendants((node, pos) => {
    const carries = node.marks.some(
      (mark) =>
        mark.type.name === COMMENT_MARK && mark.attrs.threadId === threadId,
    );
    if (!carries) return true;
    const from = pos;
    const to = pos + node.nodeSize;
    // Runs next to each other are one stretch as far as a reader is
    // concerned: a bold word inside a commented sentence splits the text into
    // three nodes carrying the same thread.
    const last = found[found.length - 1];
    if (last !== undefined && last.to === from) {
      found[found.length - 1] = { from: last.from, to };
      return true;
    }
    found.push({ from, to });
    return true;
  });
  return found;
}

/**
 * The words one comment is about.
 * @param doc - The body to read.
 * @param threadId - Which thread.
 * @returns Its words, stretches joined by a space; null once they are gone.
 */
export function threadQuoteIn(
  doc: ProseMirrorNode,
  threadId: string,
): string | null {
  const ranges = threadRangesIn(doc, threadId);
  if (ranges.length === 0) return null;
  return ranges.map((at) => doc.textBetween(at.from, at.to)).join(' ');
}
