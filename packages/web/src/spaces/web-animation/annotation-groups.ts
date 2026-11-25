// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the annotation panel lists (#1490 design §7.1, §10.1): this Space's threads grouped by the result they point at,
 * groups in the execution list's order (results it has not loaded after), threads in a group by their time.
 */

import type { ThreadData } from '@blocknote/core/comments';
import { readWebAnimationAnchor, type WebAnimationAnchor } from '@breatic/shared/space-content';

import { bodyText } from '@web/spaces/document/use-comment-cards';

/** The part of a BlockNote thread the panel reads. */
export type AnnotationThread = Pick<ThreadData, 'id' | 'resolved' | 'deletedAt' | 'metadata' | 'comments'>;

/** One listed thread with its anchor. */
export interface ListedAnnotation<T extends AnnotationThread = AnnotationThread> {
  id: string;
  anchor: WebAnimationAnchor;
  thread: T;
}

/** One result's threads. */
export interface AnnotationGroup<T extends AnnotationThread = AnnotationThread> {
  executionId: string;
  threads: ListedAnnotation<T>[];
}

/**
 * A thread's anchor, when it is live and has one.
 * @param thread - The thread.
 * @returns The anchor, or null.
 * @throws {never} Never.
 */
export function anchorOf(thread: Pick<AnnotationThread, 'deletedAt' | 'metadata'>): WebAnimationAnchor | null {
  return thread.deletedAt === undefined ? readWebAnimationAnchor(thread.metadata) : null;
}

/**
 * The panel's groups.
 * @param threads - Every thread of the Space.
 * @param options - How to list them.
 * @param options.order - Result ids in the execution list's order.
 * @param options.filter - `open` leaves resolved threads out.
 * @returns The groups, empty ones dropped.
 * @throws {never} Never.
 */
export function annotationGroups<T extends AnnotationThread>(
  threads: readonly T[],
  options: { order: readonly string[]; filter: 'open' | 'all' },
): AnnotationGroup<T>[] {
  const byResult = new Map<string, ListedAnnotation<T>[]>();
  for (const thread of threads) {
    if (options.filter === 'open' && thread.resolved) continue;
    const anchor = anchorOf(thread);
    if (anchor === null) continue;
    const listed = byResult.get(anchor.executionId) ?? [];
    listed.push({ id: thread.id, anchor, thread });
    byResult.set(anchor.executionId, listed);
  }
  const rank = new Map(options.order.map((id, index) => [id, index]));
  return [...byResult.entries()]
    .sort(([a], [b]) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER))
    .map(([executionId, listed]) => ({ executionId, threads: listed.sort((a, b) => a.anchor.timeSeconds - b.anchor.timeSeconds) }));
}

/**
 * A thread's summary: the text of its first comment that is not deleted, as its marker, tooltip and panel item show it.
 * @param thread - The thread.
 * @returns The text, empty when every comment is deleted.
 * @throws {never} Never.
 */
export function threadSummary(thread: Pick<AnnotationThread, 'comments'>): string {
  const first = thread.comments.find((comment) => comment.deletedAt === undefined);
  return first === undefined ? '' : bodyText(first.body);
}
