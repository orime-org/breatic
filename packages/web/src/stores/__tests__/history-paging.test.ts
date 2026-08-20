// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 「加载更早」翻到哪儿了，跟屏幕上那份列表是同一件事。
 *
 * 迁移之后，屏幕上的消息在 `Chat` 实例里，而「翻到哪儿了」留在 store 里。切走
 * 再切回来时 store 会被服务端最新那一页重新写一遍（会话实例按设计原样保留，那
 * 是 A4 要的），于是两边说的不是同一件事：屏幕上还是全部，游标却退回了这一页
 * 的起点。再按一次「加载更早」，服务端会把已经在屏幕上的那一页原样再给一次，
 * 而它会被插到列表头部，同一批消息出现两遍。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000 })),
    openChat: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';

const P = 'p-1';
const C = 'c-1';
const OTHER = 'c-2';

/**
 * 一条消息。
 * @param id - 它的 id。
 * @param turn - 它属于第几轮。
 * @returns 服务端那一侧的形状。
 */
function said(id: string, turn: number): Record<string, unknown> {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: id }],
    metadata: { turnIndex: turn, ts: '2026-08-20T00:00:00Z' },
  };
}

/** 服务端手里那一页，永远是最新的 30 条那一段。 */
const NEWEST_PAGE = {
  conversations: [{ id: C }],
  current: {
    conversation: { id: C, title: null },
    messages: [said('m12', 12)],
    hasMore: true,
  },
};

/** 比它更早的那一页。 */
const EARLIER_PAGE = { messages: [said('m4', 4)], hasMore: false };

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  vi.mocked(chatApi.openChat).mockResolvedValue(
    NEWEST_PAGE as unknown as Awaited<ReturnType<typeof chatApi.openChat>>,
  );
  vi.mocked(chatApi.readConversation).mockImplementation(
    async (id: string) =>
      ({
        conversation: { id, title: null },
        messages: id === C ? [said('m12', 12)] : [],
        hasMore: id === C,
      }) as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>,
  );
  vi.mocked(chatApi.messagesBefore).mockResolvedValue(
    EARLIER_PAGE as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>,
  );
});

afterEach(() => {
  evictAllChatSessions();
});

describe('翻过页之后又回到这条会话', () => {
  it('不会把已经在屏幕上的那一页再要一次', async () => {
    await conversationRuntime.ensureLoaded(P);
    // 面板建起这条会话的实例，此后屏幕上那份列表就是它的。
    chatSessionFor({
      projectId: P,
      conversationId: C,
      history: [said('m12', 12)] as never,
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });

    await conversationRuntime.loadEarlier(C);
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(1);
    expect(chatApi.messagesBefore).toHaveBeenLastCalledWith(C, 12, expect.anything());

    // 切到另一条，再切回来。服务端仍然只有最新那一页可给。
    await conversationRuntime.switchTo(P, OTHER);
    await conversationRuntime.switchTo(P, C);
    await conversationRuntime.loadEarlier(C);

    // 更早那一页已经拿过了，而且服务端说过它后面没有了。再按一次不该重新去要。
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(1);
  });

  it('屏幕上那份列表不会同一条出现两遍', async () => {
    await conversationRuntime.ensureLoaded(P);
    const chat = chatSessionFor({
      projectId: P,
      conversationId: C,
      history: [said('m12', 12)] as never,
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });

    await conversationRuntime.loadEarlier(C);
    await conversationRuntime.switchTo(P, OTHER);
    await conversationRuntime.switchTo(P, C);
    await conversationRuntime.loadEarlier(C);

    expect(chat.messages.map((m) => m.id)).toEqual(['m4', 'm12']);
  });
});
