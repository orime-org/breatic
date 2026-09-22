// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one comment card is in (#18, design §9.2).
 *
 * A thread's state is two independent bits, and this is the one place they are
 * read together:
 *
 * | bit | lives where | written by |
 * |---|---|---|
 * | `resolved` | the thread in the `comments` map | resolve / unresolve |
 * | has a range | whether the body carries a mark for it | any edit to the body |
 *
 * The second bit is derived and stored nowhere, which is why it is asked of
 * the position table rather than of the mark. The mark's own `orphan`
 * attribute cannot answer it: the library sets that from
 * `!thread || thread.resolved || thread.deletedAt`
 * (`comments/extension.ts:138-142`), so a resolved thread's mark carries
 * `orphan: true` while its text is intact. That attribute says whether to
 * paint the mark; this function says what the card is.
 */

/** The four combinations of the two bits, per design §9.2. */
export type CommentCardState =
  | 'open'
  | 'resolved'
  | 'orphaned'
  | 'resolvedOrphaned';

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
 * Reads the two bits of one thread into the state its card is in.
 * @param thread - The thread, for its resolved flag.
 * @param threadId - Which thread to look up in the table.
 * @param positions - Ranges the body currently carries, keyed by thread id;
 *   a thread missing from it has lost the text it pointed at.
 * @returns Which of the four states that card is in.
 */
export function commentCardState(
  thread: ResolvableThread,
  threadId: string,
  positions: ReadonlyMap<string, ThreadRange>,
): CommentCardState {
  const resolved = thread.resolved === true;
  const hasRange = positions.has(threadId);

  if (resolved) return hasRange ? 'resolved' : 'resolvedOrphaned';
  return hasRange ? 'open' : 'orphaned';
}
