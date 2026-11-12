// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The waiting area of each conversation (inner#1717): what the server's queue
 * holds, as the last answer that carried it said, and why it waits when the
 * server says it waits for a card or for credits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatPendingItem } from '@breatic/shared';
import { chatWaiting, useChatWaiting } from '@web/stores/chat-waiting';

/**
 * A waiting message.
 * @param id - Its id.
 * @returns The item.
 */
function item(id: string): ChatPendingItem {
  return { id, sentAt: '2026-11-12T08:00:00.000Z', words: `words ${id}`, chips: [] };
}

beforeEach(() => {
  chatWaiting.clearAll();
});

describe('the waiting area', () => {
  it('is what the last answer said the queue holds (WB-13)', () => {
    chatWaiting.fromSend('c1', [item('m1')]);
    chatWaiting.fromSync('c1', { pending: [item('m1'), item('m2')], awaiting: false, blocked: false });
    expect(useChatWaiting.getState().byConversation.c1?.pending.map((p) => p.id)).toEqual(['m1', 'm2']);
  });

  it('says a card waits, and that credits are short, only while the server says so (WB-14, WB-15)', () => {
    chatWaiting.fromSync('c1', { pending: [item('m1')], awaiting: true, blocked: false });
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ awaiting: true, blocked: false });
    chatWaiting.fromSync('c1', { pending: [item('m1')], awaiting: false, blocked: true });
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ awaiting: false, blocked: true });
    chatWaiting.fromSend('c1', [item('m1')]);
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ awaiting: false, blocked: false });
  });

  it('lets a message go once a run took it in, or it was taken back (WB-22)', () => {
    chatWaiting.fromSend('c1', [item('m1'), item('m2'), item('m3')]);
    chatWaiting.taken('c1', 'm2');
    chatWaiting.taken('c1', 'nowhere');
    chatWaiting.drop('c1', 'm3');
    expect(useChatWaiting.getState().byConversation.c1?.pending.map((p) => p.id)).toEqual(['m1']);
  });

  it('keeps each conversation apart, and forgets one on its own', () => {
    chatWaiting.fromSend('c1', [item('m1')]);
    chatWaiting.fromSend('c2', [item('m2')]);
    chatWaiting.forget('c1');
    expect(useChatWaiting.getState().byConversation.c1).toBeUndefined();
    expect(useChatWaiting.getState().byConversation.c2?.pending.map((p) => p.id)).toEqual(['m2']);
  });

  it('marks which message is being taken back, and how, until the answer comes', () => {
    chatWaiting.fromSend('c1', [item('m1')]);
    chatWaiting.busy('c1', 'm1', 'retract');
    expect(useChatWaiting.getState().byConversation.c1?.busy).toEqual({ m1: 'retract' });
    chatWaiting.busy('c1', 'm1', undefined);
    expect(useChatWaiting.getState().byConversation.c1?.busy).toEqual({});
  });
});
