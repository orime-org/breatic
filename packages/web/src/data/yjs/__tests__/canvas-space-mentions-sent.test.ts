// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A canvas note, reply or edit that mentions members asks collab to record
 * the mention once the words are written (#1488 §11.6, §11.9); words that
 * mention nobody, or a write that did not land, ask nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasNodeFields, CommentMention } from '@breatic/shared';

const notifyMentioned = vi.hoisted(() => vi.fn());

vi.mock('@web/data/yjs/comment-requests', async (real) => ({
  ...(await real<typeof import('@web/data/yjs/comment-requests')>()),
  notifyMentioned,
}));

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode, addReply, editAnnotationBody, editReply } from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';
const alice: CommentMention = { userId: 'u2', projectId: PID, mentionedAt: 7, label: '@Alice' };

/**
 * A note, with mentions when given.
 * @param id - Its id.
 * @param mentions - Whom its body mentions.
 * @returns Wire fields.
 */
const note = (id: string, mentions?: CommentMention[]): CanvasNodeFields => ({
  id,
  type: 'annotation',
  position: { x: 0, y: 0 },
  data: {
    name: 'Note',
    locked: false,
    attachments: [],
    content: '@Alice look',
    createdBy: 'u1',
    createdAt: 1,
    ...(mentions ? { mentions } : {}),
  },
});

beforeEach(() => {
  _resetForTests();
  notifyMentioned.mockClear();
});

describe('mentions on a canvas note ask collab to record them', () => {
  it('for a new note', () => {
    addNode(PID, SID, note('a1', [alice]));
    expect(notifyMentioned).toHaveBeenCalledWith(PID, SID, 'canvas', 'a1');
  });

  it('for a reply', () => {
    addNode(PID, SID, note('a1'));
    expect(addReply(PID, SID, 'a1', { id: 'r1', content: '@Alice see', createdBy: 'u1', createdAt: 2, mentions: [alice] })).toBe(true);
    expect(notifyMentioned).toHaveBeenCalledWith(PID, SID, 'canvas', 'r1');
  });

  it('for an edited body and an edited reply', () => {
    addNode(PID, SID, note('a1'));
    addReply(PID, SID, 'a1', { id: 'r1', content: 'see', createdBy: 'u1', createdAt: 2 });
    notifyMentioned.mockClear();
    editAnnotationBody(PID, SID, 'a1', '@Alice now', 3, [alice]);
    editReply(PID, SID, 'a1', 'r1', '@Alice too', 4, [alice]);
    expect(notifyMentioned.mock.calls).toEqual([
      [PID, SID, 'canvas', 'a1'],
      [PID, SID, 'canvas', 'r1'],
    ]);
  });

  it('not for words that mention nobody', () => {
    addNode(PID, SID, note('a1'));
    addReply(PID, SID, 'a1', { id: 'r1', content: 'plain', createdBy: 'u1', createdAt: 2 });
    editAnnotationBody(PID, SID, 'a1', 'plain', 3, []);
    expect(notifyMentioned).not.toHaveBeenCalled();
  });

  it('not for a reply to a note that is gone', () => {
    expect(addReply(PID, SID, 'gone', { id: 'r1', content: '@Alice', createdBy: 'u1', createdAt: 2, mentions: [alice] })).toBe(false);
    expect(notifyMentioned).not.toHaveBeenCalled();
  });
});
