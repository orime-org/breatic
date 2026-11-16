// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How the newest page of history read back before attaching to a run is laid
 * over what is on screen (inner#1717): joined from its first turn on when the
 * list reaches that far, so what "load earlier" brought up stays; in place of
 * the list when it does not, so no gap is left that "load earlier" could not
 * fill.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { StoredUiMessage } from '@web/data/api/chat';
import { chatSessionFor, evictAllChatSessions, layLatestPage } from '@web/stores/chat-sessions';

/**
 * A stored message.
 * @param turn - Its turn.
 * @param role - Who said it.
 * @returns The message.
 */
function row(turn: number, role: 'user' | 'assistant' = 'user'): StoredUiMessage {
  return { id: `${role}-${String(turn)}`, role, parts: [{ type: 'text', text: `${role} ${String(turn)}` }], metadata: { turnIndex: turn } as never };
}

/**
 * Start the conversation's list.
 * @param history - What it holds.
 * @returns The session.
 */
function start(history: StoredUiMessage[]): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p1', conversationId: 'c1', history, onTitled: () => {} });
}

beforeEach(() => {
  evictAllChatSessions();
});

describe('the newest page laid over the list', () => {
  it('replaces the list from its first turn on and keeps what is older, when it joins (WB-16)', () => {
    const chat = start([row(1), row(1, 'assistant'), row(2), row(2, 'assistant'), row(3), { id: 'drawn-here', role: 'assistant', parts: [] }]);
    const how = layLatestPage('c1', [row(2), row(2, 'assistant'), row(3), row(3, 'assistant')]);
    expect(how).toBe('joined');
    expect(chat.messages.map((m) => m.id)).toEqual(['user-1', 'assistant-1', 'user-2', 'assistant-2', 'user-3', 'assistant-3']);
  });

  it('takes the place of the list when the list does not reach it (WB-17)', () => {
    const chat = start([row(4), row(5), row(5, 'assistant')]);
    const how = layLatestPage('c1', [row(20), row(20, 'assistant')]);
    expect(how).toBe('replaced');
    expect(chat.messages.map((m) => m.id)).toEqual(['user-20', 'assistant-20']);
  });

  it('draws the opening of a run once when the run is read again from its start (WB-18)', () => {
    const chat = start([row(7)]);
    layLatestPage('c1', [row(7)]);
    expect(chat.messages.filter((m) => m.id === 'user-7')).toHaveLength(1);
  });
});
