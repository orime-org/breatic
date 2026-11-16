// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How far "load earlier" has reached is the same fact as the list on screen.
 *
 * The messages on screen live in the `Chat` instance, while how far back it
 * reaches stays in the store. Switching away and back rewrites the store with
 * the server's newest page (the session instance is kept as it is, by design),
 * so the two would disagree: the screen still holds everything while the
 * cursor falls back to that page's start. A second "load earlier" would then
 * be handed the page already on screen, put at the head of the list, and the
 * same messages would show twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatApiModule>();
  return {
    ...actual,
    chatApi: {
      streamPath: actual.chatApi.streamPath,
      streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 })),
      openChat: vi.fn(),
      messagesBefore: vi.fn(),
      readConversation: vi.fn(),
      listConversations: vi.fn(),
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
    },
  };
});

import { chatApi } from '@web/data/api/chat';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';

const P = 'p-1';
const C = 'c-1';
const OTHER = 'c-2';

/**
 * One message.
 * @param id - Its id.
 * @param turn - The turn it belongs to.
 * @returns It in the server's shape.
 */
function said(id: string, turn: number): Record<string, unknown> {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: id }],
    metadata: { turnIndex: turn, ts: '2026-08-20T00:00:00Z' },
  };
}

/** The page the server hands back, always the newest stretch. */
const NEWEST_PAGE = {
  conversations: [{ id: C }],
  current: {
    conversation: { id: C, title: null, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
    messages: [said('m12', 12)],
    hasMore: true,
  },
};

/**
 * The two earlier pages the server holds, by the turn they are asked back from.
 *
 * Two rather than one: with one page, a cursor fallen back to the start and a
 * cursor following the list ask for the same thing and cannot be told apart,
 * and the fallen-back cursor is what is pinned here.
 */
const EARLIER_PAGES: Record<number, { messages: Array<Record<string, unknown>>; hasMore: boolean }> =
  {
    12: { messages: [said('m4', 4)], hasMore: true },
    4: { messages: [said('m1', 1)], hasMore: false },
  };

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  vi.mocked(chatApi.openChat).mockResolvedValue(
    NEWEST_PAGE as unknown as Awaited<ReturnType<typeof chatApi.openChat>>,
  );
  vi.mocked(chatApi.readConversation).mockImplementation(
    async (id: string) =>
      ({
        conversation: { id, title: null, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
        messages: id === C ? [said('m12', 12)] : [],
        hasMore: id === C,
      }) as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>,
  );
  vi.mocked(chatApi.messagesBefore).mockImplementation(
    async (_id: string, beforeTurn: number) =>
      (EARLIER_PAGES[beforeTurn] ?? { messages: [], hasMore: false }) as unknown as Awaited<
        ReturnType<typeof chatApi.messagesBefore>
      >,
  );
});

afterEach(() => {
  evictAllChatSessions();
});

describe('coming back to a conversation after paging back through it', () => {
  it('does not ask again for the page already on screen', async () => {
    await conversationRuntime.ensureLoaded(P);
    // The panel makes the conversation's instance; from then on the list on
    // screen is its own.
    chatSessionFor({
      projectId: P,
      conversationId: C,
      history: [said('m12', 12)] as never,
      onTitled: () => undefined,
    });

    await conversationRuntime.loadEarlier(C);
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(1);
    expect(chatApi.messagesBefore).toHaveBeenLastCalledWith(C, 12, expect.anything());

    // Switch to another and back. The server still has only the newest page
    // to hand back.
    await conversationRuntime.switchTo(P, OTHER);
    await conversationRuntime.switchTo(P, C);
    await conversationRuntime.loadEarlier(C);

    // The second asks back from the start of the earlier page, not of the
    // newest one.
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(2);
    expect(chatApi.messagesBefore).toHaveBeenLastCalledWith(C, 4, expect.anything());
  });

  it('never shows the same message twice in the list on screen', async () => {
    await conversationRuntime.ensureLoaded(P);
    const chat = chatSessionFor({
      projectId: P,
      conversationId: C,
      history: [said('m12', 12)] as never,
      onTitled: () => undefined,
    });

    await conversationRuntime.loadEarlier(C);
    await conversationRuntime.switchTo(P, OTHER);
    await conversationRuntime.switchTo(P, C);
    await conversationRuntime.loadEarlier(C);

    // One from each of the three pages, oldest first, none twice.
    expect(chat.messages.map((m) => m.id)).toEqual(['m1', 'm4', 'm12']);
  });
});
