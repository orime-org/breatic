// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether one comment has been settled (#18, design §9.2).
 *
 * The design names two bits — settled, and whether the body still carries the
 * words. The second one reaches a card as its quote: a card with nothing to
 * quote is a card whose words are gone, read off the same walk of the body
 * that produces the quote itself (`use-comment-cards.ts`). So only the first
 * is asked here.
 *
 * It is asked of the thread rather than of the mark. The mark's own `orphan`
 * attribute answers a different question: the library sets it from
 * `!thread || thread.resolved || thread.deletedAt`
 * (`comments/extension.ts:138-142`), so a resolved thread's mark carries
 * `orphan: true` while its text is intact. That attribute says whether to
 * paint the mark.
 */

/** The half of a thread this reading needs. */
export interface ResolvableThread {
  /** Absent reads the same as false: the store leaves it off until resolved. */
  readonly resolved?: boolean;
}

/** Where one thread's marks reach in the body. */
export interface ThreadRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Whether this thread has been settled.
 * @param thread - The thread to read.
 * @returns True once somebody resolved it.
 */
export function isSettled(thread: ResolvableThread): boolean {
  return thread.resolved === true;
}
