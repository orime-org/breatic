// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the annotation panel lists (#1490 design §7.1, §10.1): this Space's threads grouped by the result they point at,
 * groups in the execution list's order, threads in a group by their time, and "Open" leaving out resolved ones. A
 * deleted thread or one without a readable anchor is not listed.
 */

import { describe, expect, it } from 'vitest';

import { annotationGroups, threadSummary, type AnnotationThread } from '@web/spaces/web-animation/annotation-groups';

const A = 'e0000000-0000-4000-8000-00000000000a';
const B = 'e0000000-0000-4000-8000-00000000000b';

/**
 * A thread at a time on a result.
 * @param id - The thread.
 * @param executionId - The result.
 * @param timeSeconds - Its time.
 * @param fields - Overrides.
 * @returns It.
 */
function thread(id: string, executionId: string, timeSeconds: number, fields: Partial<AnnotationThread> = {}): AnnotationThread {
  return { id, resolved: false, deletedAt: undefined, metadata: { webAnimationAnchor: { executionId, timeSeconds, point: null } }, comments: [], ...fields };
}

describe('annotationGroups', () => {
  it('groups threads by result in the list\'s order, and orders each group by time', () => {
    const groups = annotationGroups([thread('t3', A, 4), thread('t1', B, 1), thread('t2', A, 0.5)], { order: [B, A], filter: 'all' });
    expect(groups.map((group) => [group.executionId, group.threads.map((item) => item.id)])).toEqual([[B, ['t1']], [A, ['t2', 't3']]]);
  });

  it('puts a result the list has not loaded after those it has', () => {
    const groups = annotationGroups([thread('t1', A, 1), thread('t2', B, 1)], { order: [B], filter: 'all' });
    expect(groups.map((group) => group.executionId)).toEqual([B, A]);
  });

  it('leaves resolved threads out under Open and keeps them under All', () => {
    const threads = [thread('t1', A, 1), thread('t2', A, 2, { resolved: true })];
    expect(annotationGroups(threads, { order: [A], filter: 'open' })[0]?.threads.map((item) => item.id)).toEqual(['t1']);
    expect(annotationGroups(threads, { order: [A], filter: 'all' })[0]?.threads.map((item) => item.id)).toEqual(['t1', 't2']);
  });

  it('drops a group whose threads are all filtered out', () => {
    expect(annotationGroups([thread('t1', A, 1, { resolved: true })], { order: [A], filter: 'open' })).toEqual([]);
  });

  it('lists neither a deleted thread nor one without a readable anchor', () => {
    const groups = annotationGroups([thread('t1', A, 1, { deletedAt: new Date(0) }), { ...thread('t2', A, 1), metadata: {} }, thread('t3', A, 2)], { order: [A], filter: 'all' });
    expect(groups[0]?.threads.map((item) => item.id)).toEqual(['t3']);
  });
});

describe('threadSummary', () => {
  /**
   * A comment with one paragraph.
   * @param text - Its words.
   * @param deleted - Whether it is deleted.
   * @returns It.
   */
  const comment = (text: string, deleted = false): AnnotationThread['comments'][number] =>
    ({ id: text, body: [{ type: 'paragraph', content: [{ type: 'text', text }] }], deletedAt: deleted ? new Date(0) : undefined }) as unknown as AnnotationThread['comments'][number];

  it('reads the first comment that is not deleted', () => {
    expect(threadSummary({ comments: [comment('gone', true), comment('first'), comment('second')] })).toBe('first');
  });

  it('is empty when every comment is deleted', () => {
    expect(threadSummary({ comments: [comment('gone', true)] })).toBe('');
  });
});
