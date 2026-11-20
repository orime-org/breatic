// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a canvas comment thread stores for mentions and hand-overs (#1488
 * §11.6, §11.7), read back the way collab reads it.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { CommentMention } from '@shared/types/canvas-node.js';
import { readCommentMentions } from '@shared/comment-records.js';
import {
  addNodeInDoc,
  addReplyInDoc,
  editAnnotationBodyInDoc,
  editReplyInDoc,
} from '@shared/canvas/model/canvas-write.js';
import { createAnnotationNode } from '@shared/canvas/model/node-factory.js';

const alice: CommentMention = { userId: 'u1', projectId: 'p1', mentionedAt: 10, label: '@Alice' };
const bob: CommentMention = { userId: 'u2', projectId: 'p1', mentionedAt: 20, label: '@Bob' };

/**
 * A canvas with one annotation by u0.
 * @param mentions - What its body mentions.
 * @returns The doc and the annotation's id.
 */
function board(mentions?: CommentMention[]): { doc: Y.Doc; id: string } {
  const doc = new Y.Doc();
  const node = createAnnotationNode({ x: 0, y: 0 }, 'u0', 'ask @Alice', mentions);
  addNodeInDoc(doc, node);
  return { doc, id: node.id };
}

describe('mentions on a canvas thread', () => {
  it('stores the body mentions given at creation', () => {
    const { doc, id } = board([alice]);
    expect(readCommentMentions('canvas', doc, 'p1')).toEqual([
      { entryId: id, threadId: id, authorId: 'u0', userId: 'u1', mentionedAt: 10 },
    ]);
  });

  it('stores a reply mentions', () => {
    const { doc, id } = board();
    addReplyInDoc(doc, id, { id: 'r1', content: '@Bob', createdBy: 'u3', createdAt: 1, mentions: [bob] });
    expect(readCommentMentions('canvas', doc, 'p1')).toEqual([
      { entryId: 'r1', threadId: id, authorId: 'u3', userId: 'u2', mentionedAt: 20 },
    ]);
  });

  it('replaces the body mentions on edit, and clears them when none are left', () => {
    const { doc, id } = board([alice]);
    editAnnotationBodyInDoc(doc, id, '@Bob', 2, [bob]);
    expect(readCommentMentions('canvas', doc, 'p1').map((m) => m.userId)).toEqual(['u2']);
    editAnnotationBodyInDoc(doc, id, 'nobody', 3, []);
    expect(readCommentMentions('canvas', doc, 'p1')).toEqual([]);
  });

  it('leaves the body mentions alone when an edit passes none', () => {
    const { doc, id } = board([alice]);
    editAnnotationBodyInDoc(doc, id, 'ask @Alice again', 2);
    expect(readCommentMentions('canvas', doc, 'p1').map((m) => m.userId)).toEqual(['u1']);
  });

  it('replaces a reply mentions on edit', () => {
    const { doc, id } = board();
    addReplyInDoc(doc, id, { id: 'r1', content: '@Bob', createdBy: 'u3', createdAt: 1, mentions: [bob] });
    editReplyInDoc(doc, id, 'r1', '@Alice', 2, [alice]);
    expect(readCommentMentions('canvas', doc, 'p1').map((m) => m.userId)).toEqual(['u1']);
  });
});
