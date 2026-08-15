// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a switch, and a delete, must not do to the conversation underneath.
 *
 * Every case here started as a Gate 2 finding that reproduced. They are kept
 * because each one guards an invariant nothing else was watching: a turn
 * survives being switched away from, the last press wins, and a panel whose
 * conversation has just been deleted says it is loading rather than drawing an
 * empty conversation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSE_EVENT_NAMES } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import {
  conversationRuntime,
  turnPhaseOf,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';

const P = 'p-1';
let handlers: { onEvent: (e: SSEEventEnvelope) => void; signal?: AbortSignal };

function opens(list: Array<{ id: string; title: string | null }>, current = list[0]!.id): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: list,
    current: { conversation: list.find((c) => c.id === current)!, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('switching away from a running turn and back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    vi.mocked(chatApi.streamMessage).mockImplementation((_i, h) => {
      handlers = h as typeof handlers;
      return new Promise<void>(() => {});
    });
  });

  it('keeps the turn, and keeps it stoppable', async () => {
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    void conversationRuntime.send(P, 'a long question');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().conversations['c-1']?.turn).not.toBeNull(),
    );
    handlers.onEvent({
      event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
      data: { messages: [], hasMore: false, title: 'a long question' },
    } as unknown as SSEEventEnvelope);
    handlers.onEvent({
      event: SSE_EVENT_NAMES.CHAT_CHUNK,
      data: { content: 'part one' },
    } as unknown as SSEEventEnvelope);

    const signal = handlers.signal;
    const before = {
      hasTurn: useConversationRuntime.getState().conversations['c-1']?.turn !== null,
      phase: turnPhaseOf(useConversationRuntime.getState(), P),
    };

    vi.mocked(chatApi.readConversation).mockImplementation((id) =>
      Promise.resolve({
        conversation: { id, title: id },
        messages: [],
        hasMore: false,
      } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>),
    );
    await conversationRuntime.switchTo(P, 'c-2');
    await conversationRuntime.switchTo(P, 'c-1');

    const after = {
      hasTurn: useConversationRuntime.getState().conversations['c-1']?.turn !== null,
      phase: turnPhaseOf(useConversationRuntime.getState(), P),
    };
    conversationRuntime.stopTurn('c-1');
    conversationRuntime.leaveProject(P);

    expect(before.hasTurn).toBe(true);
    expect(after.hasTurn).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

describe('two switches whose answers come back out of order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('lands on the one the reader pressed last', async () => {
    opens([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: 'three' },
    ]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.readConversation).mockImplementation((id) => {
      const answer = {
        conversation: { id, title: id },
        messages: [],
        hasMore: false,
      } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>;
      return id === 'c-2'
        ? new Promise((r) => setTimeout(() => r(answer), 30))
        : Promise.resolve(answer);
    });

    const slow = conversationRuntime.switchTo(P, 'c-2');
    const fast = conversationRuntime.switchTo(P, 'c-3');
    await Promise.all([slow, fast]);

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-3');
  });
});

describe('deleting the conversation on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not draw an empty conversation while the next one is on its way', async () => {
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.readConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.remove(P, 'c-1');

    // What matters is what the panel draws, not which id an internal map
    // happens to hold: the empty-conversation greeting is gated on this
    // status, so anything but `ready` keeps it off the screen. Landing on
    // `failed` also puts the scrim up, which is the right answer when the
    // conversation meant to replace it could not be read.
    expect(useConversationRuntime.getState().openStatus[P]).not.toBe('ready');
  });
});

describe('a new conversation started while a switch is still out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('leaves the reader in the one they just created', async () => {
    // 按 + 是读者最后一次明示的导航。在途的那次切换比它早，落地却比它晚，
    // 于是读者被从刚建的会话里拽回去，而新建的那条挂在列表顶上没人进去。
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    let releaseRead: (() => void) | undefined;
    vi.mocked(chatApi.readConversation).mockImplementation(
      (id) =>
        new Promise((resolve) => {
          releaseRead = () =>
            resolve({
              conversation: { id, title: id },
              messages: [],
              hasMore: false,
            } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
        }),
    );
    const switching = conversationRuntime.switchTo(P, 'c-2');

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);
    await conversationRuntime.startNew(P);
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new');

    releaseRead?.();
    await switching;

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new');
  });
});

describe('picking another row while a delete is in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('leaves the reader on the row they picked', async () => {
    // 删除的落点是「删完之后该显示哪条」，它在请求发出前就把答案定死了。
    // 读者在这一趟往返里点了另一行，那才是他最后一次明示的选择。
    opens([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: 'three' },
    ]);
    await conversationRuntime.ensureLoaded(P);

    let releaseDelete: (() => void) | undefined;
    vi.mocked(chatApi.deleteConversation).mockImplementation(
      () => new Promise<void>((resolve) => (releaseDelete = resolve)),
    );
    vi.mocked(chatApi.readConversation).mockImplementation((id) =>
      Promise.resolve({
        conversation: { id, title: id },
        messages: [],
        hasMore: false,
      } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>),
    );

    const removing = conversationRuntime.remove(P, 'c-1');
    await conversationRuntime.switchTo(P, 'c-3');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-3');

    releaseDelete?.();
    await removing;

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-3');
  });
});

describe('a draft typed before the project had a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not follow the reader back into the project', async () => {
    // 这半句话是在上一次访问里打的。它没有归属会话，所以按「属于哪条会话」
    // 筛选的清理看不见它，回来时会被搬进这次打开的那条会话。
    opens([{ id: 'c-1', title: 'one' }]);
    conversationRuntime.setDraft(P, undefined, 'half a sentence');
    conversationRuntime.leaveProject(P);

    await conversationRuntime.ensureLoaded(P);

    expect(conversationRuntime.draftOf(P, 'c-1')).toBe('');
  });
});
