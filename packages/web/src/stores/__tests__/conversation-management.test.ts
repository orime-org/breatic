// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Having more than one conversation in a project, and moving between them.
 *
 * The sibling file covers what one conversation does on its own. This one is
 * about the several: the list, switching, starting another, naming, removing,
 * and the half-typed message each of them is holding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
import {
  conversationRuntime,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';
import {
  chatSessionFor,
  evictAllChatSessions,
  sendInSession,
  stopChatSession,
} from '@web/stores/chat-sessions';

const PROJECT = 'p-1';

/**
 * Answer the open call with a list and whichever one is current.
 * @param conversations - The list as the server would give it
 * @param currentId - Which of them the panel lands on
 * @param over - What else the answer says
 * @param over.hasMoreConversations - The list goes on past this page
 */
function openAnswers(
  conversations: Array<{ id: string; title: string | null }>,
  currentId: string,
  over: { hasMoreConversations?: boolean } = {},
): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations,
    hasMoreConversations: over.hasMoreConversations ?? false,
    current: {
      conversation: conversations.find((c) => c.id === currentId)!,
      messages: [],
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}


/**
 * 说一句话,并让服务端在这一轮的流上带回会话的名字。
 *
 * 走的是真实那条路:名字是服务端在 `data-conversation-titled` 上说的,会话
 * 实例听见了转给这个 store。测试直接调那个内部函数就绕开了这条线,而线断了
 * 没有任何测试会红。
 * @param conversationId - 说话的那条会话。
 * @param said - 说了什么。
 * @param title - 服务端回的名字。
 */
async function speakAndHearTitle(
  conversationId: string,
  said: string,
  title: string,
): Promise<void> {
  let push: ((chunk: Record<string, unknown>) => void) | undefined;
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      push = (chunk) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );

  chatSessionFor({
    projectId: PROJECT,
    conversationId,
    history: [],
    onTitled: (named) => conversationRuntime.noteActivity(PROJECT, conversationId, named),
  });
  void sendInSession(conversationId, said);
  await vi.waitFor(() => {
    expect(push).toBeDefined();
  });
  push?.({ type: 'data-conversation-titled', data: { title } });
  await vi.waitFor(() => {
    expect(useConversationRuntime.getState().conversations[conversationId]?.title).toBe(title);
  });
  stopChatSession(conversationId);
  vi.unstubAllGlobals();
}

/** The conversation the panel is showing in this project. */
function currentId(): string | undefined {
  return useConversationRuntime.getState().currentByProject[PROJECT];
}

/** The list the panel would render, in the order it would render it. */
function listedIds(): string[] {
  return (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id);
}

describe('the list of conversations in a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('keeps the list that came back with the open call', async () => {
    // It arrives with the messages and was being thrown away, which is why
    // the history sheet had nothing to show even once it could be opened.
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: null }], 'c-1');

    await conversationRuntime.ensureLoaded(PROJECT);

    expect(listedIds()).toEqual(['c-1', 'c-2']);
    expect(currentId()).toBe('c-1');
  });

  it('forgets the list when the reader leaves the project', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    conversationRuntime.leaveProject(PROJECT);

    expect(listedIds()).toEqual([]);
  });
});

describe('switching to another conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('shows the one that was picked, with its own messages', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [
        {
          id: 'm-9',
          role: 'user',
          parts: [{ type: 'text', text: 'said in the other one' }],
          metadata: { turnIndex: 3, ts: '2026-08-15T00:00:00Z' },
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(currentId()).toBe('c-2');
    const held = useConversationRuntime.getState().conversations['c-2'];
    expect(held?.messages.map((m) => m.id)).toEqual(['m-9']);
    // Carried across, or the panel it lands in cannot know whether there is
    // anything for "load earlier" to load.
    expect(held?.hasMore).toBe(true);
  });

  it('leaves the panel where it was when the switch fails', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(currentId()).toBe('c-1');
  });

  it('does not ask again for one it is already showing', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    await conversationRuntime.switchTo(PROJECT, 'c-1');

    expect(chatApi.readConversation).not.toHaveBeenCalled();
  });
});

describe('starting another conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('switches to the new one only once the server has made it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);

    await conversationRuntime.startNew(PROJECT);

    expect(currentId()).toBe('c-new');
    expect(listedIds()).toContain('c-new');
  });

  it('changes nothing when the server does not make it', async () => {
    // The panel stays on the conversation the reader was in, with whatever
    // they had typed still in front of them.
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft('c-1', 'half a sentence');
    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.startNew(PROJECT);

    expect(currentId()).toBe('c-1');
    expect(listedIds()).toEqual(['c-1']);
    expect(conversationRuntime.draftOf('c-1')).toBe('half a sentence');
  });

  it('puts the new one at the top, where the most recent one belongs', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);

    await conversationRuntime.startNew(PROJECT);

    expect(listedIds()).toEqual(['c-new', 'c-1']);
  });
});

describe('naming a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('shows the new name in the list', async () => {
    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.renameConversation).mockResolvedValue({
      id: 'c-1',
      title: 'Storyboard notes',
    } as unknown as Awaited<ReturnType<typeof chatApi.renameConversation>>);

    await conversationRuntime.rename(PROJECT, 'c-1', 'Storyboard notes');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('Storyboard notes');
  });

  it('leaves the old name in place when the rename fails', async () => {
    openAnswers([{ id: 'c-1', title: 'the old one' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.renameConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.rename(PROJECT, 'c-1', 'never lands');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('the old one');
  });

  it('takes the name the turn gives it when the first message names it', async () => {
    // The server names a conversation after its first message and says so on
    // the event that opens the turn. Without taking it here, the list goes on
    // showing the placeholder until the reader leaves and comes back.
    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    await speakAndHearTitle('c-1', 'find me a reference', 'find me a reference');

    const listed = useConversationRuntime.getState().listByProject[PROJECT];
    expect(listed?.[0]?.title).toBe('find me a reference');
  });
});

describe('removing a conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('takes it out of the list', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);

    await conversationRuntime.remove(PROJECT, 'c-2');

    expect(listedIds()).toEqual(['c-1']);
    expect(currentId()).toBe('c-1');
  });

  it('moves to the next one when the reader deletes the one they are in', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    await conversationRuntime.remove(PROJECT, 'c-1');

    expect(listedIds()).toEqual(['c-2']);
    expect(currentId()).toBe('c-2');
  });

  it('opens a fresh one when the last conversation is deleted', async () => {
    // Opening chat in a project with none makes one, which is the same answer
    // the reader would get by leaving and coming back.
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-fresh', title: null }],
      current: {
        conversation: { id: 'c-fresh', title: null },
        messages: [],
        hasMore: false,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    await conversationRuntime.remove(PROJECT, 'c-1');

    expect(currentId()).toBe('c-fresh');
    expect(listedIds()).toEqual(['c-fresh']);
  });

  it('leaves the list alone when the delete fails', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.deleteConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.remove(PROJECT, 'c-2');

    expect(listedIds()).toEqual(['c-1', 'c-2']);
  });
});

describe('what each conversation has half-typed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('holds one draft per conversation, not one for the panel', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft('c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(conversationRuntime.draftOf('c-2')).toBe('');
  });

  it('gives back what was left in a conversation on returning to it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft('c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-1', title: 'first' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    await conversationRuntime.switchTo(PROJECT, 'c-1');

    expect(conversationRuntime.draftOf('c-1')).toBe('half a thought');
  });

  it('forgets every draft in a project once the reader leaves it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft('c-1', 'half a thought');

    conversationRuntime.leaveProject(PROJECT);

    expect(conversationRuntime.draftOf('c-1')).toBe('');
  });
});

describe('what the list says about when a conversation was last used', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('moves the one just spoken in to the top, and freshens its time', async () => {
    // The list is the server's answer from when the project opened, and the
    // server will not mention it again until the project is re-opened. So
    // speaking in a conversation has to be recorded here, or the row goes on
    // claiming it was last used days ago -- and `remove` reads this order to
    // decide where to land.
    const old = '2026-08-01T00:00:00Z';
    openAnswers(
      [
        { id: 'c-1', title: 'first' },
        { id: 'c-2', title: 'second' },
      ],
      'c-2',
    );
    await conversationRuntime.ensureLoaded(PROJECT);
    // 两行都标成很久以前,好看出说话之后哪一行的时间被刷新了。
    useConversationRuntime.setState((st) => ({
      listByProject: {
        ...st.listByProject,
        [PROJECT]: (st.listByProject[PROJECT] ?? []).map((c) => ({ ...c, updatedAt: old })),
      },
    }));

    await speakAndHearTitle('c-2', 'said something', 'said something');

    const listed = useConversationRuntime.getState().listByProject[PROJECT]!;
    expect(listed.map((c) => c.id)).toEqual(['c-2', 'c-1']);
    expect(listed[0]!.title).toBe('said something');
    expect(listed[0]!.updatedAt).not.toBe(old);
  });
});

describe('what the box holds while no conversation is on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('holds nothing, because the box is not open for typing then', async () => {
    // 打开面板那一趟往返里输入框是只读的 —— 它跟切换会话走同一道闸门。所以
    // 「还没有会话可归」这种草稿产生不出来,也就不该有一个键去存它:留着那套
    // 转交的机制,就是留一段谁也走不到的代码。
    conversationRuntime.setDraft(undefined, 'nowhere to put this');

    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    expect(conversationRuntime.draftOf('c-1')).toBe('');
  });

  it('keeps each conversation its own', async () => {
    openAnswers(
      [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      'c-1',
    );
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft('c-1', 'half a sentence');

    expect(conversationRuntime.draftOf('c-2')).toBe('');
    expect(conversationRuntime.draftOf('c-1')).toBe('half a sentence');
  });
});

describe('a list longer than one page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('adds the next page to the end of the one on screen', async () => {
    // 「加载更多」不是「重新加载」：已经在屏幕上的那些行一行不动，新的接在后面。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-2', title: 'two' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.loadMoreConversations(PROJECT);

    const listed = useConversationRuntime.getState().listByProject[PROJECT] ?? [];
    expect(listed.map((c) => c.id)).toEqual(['c-1', 'c-2']);
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(false);
  });

  it('continues from the last row it already has', async () => {
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.loadMoreConversations(PROJECT);

    expect(chatApi.listConversations).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ id: 'c-1' }),
      expect.anything(),
    );
  });

  it('does not ask again once the list has run out', async () => {
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: false });
    await conversationRuntime.ensureLoaded(PROJECT);

    await conversationRuntime.loadMoreConversations(PROJECT);

    expect(chatApi.listConversations).not.toHaveBeenCalled();
  });

  it('keeps the rows it has when the next page cannot be fetched', async () => {
    // 拉不到下一页说明的是「还有一段没拿到」，不是「已经拿到的那些不算数了」。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockRejectedValue(new Error('offline'));
    await conversationRuntime.loadMoreConversations(PROJECT);

    const listed = useConversationRuntime.getState().listByProject[PROJECT] ?? [];
    expect(listed.map((c) => c.id)).toEqual(['c-1']);
    // 还有一段没拿到，所以下一次滑到底还要再试。
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(true);
  });

  it('only has one request out at a time', async () => {
    // 滚动会连着触发很多次。每一次都发一个请求，拿回来的是同一段行，
    // 它们会被接在列表后面变成重复的行。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ conversations: [{ id: 'c-2', title: 'two' }], hasMore: true } as never),
            5,
          ),
        ),
    );
    await Promise.all([
      conversationRuntime.loadMoreConversations(PROJECT),
      conversationRuntime.loadMoreConversations(PROJECT),
      conversationRuntime.loadMoreConversations(PROJECT),
    ]);

    expect(chatApi.listConversations).toHaveBeenCalledTimes(1);
    const listed = useConversationRuntime.getState().listByProject[PROJECT] ?? [];
    expect(listed.map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });
});

describe('opening the list again', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('fetches the first page afresh rather than showing what it had', async () => {
    // 打开列表是一次取数的时刻。上一次翻到哪儿、上一次看到什么,都不该决定
    // 这一次看到什么 —— 那期间另一个标签页可能建过、删过、改过名。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [
        { id: 'c-9', title: 'made in another tab' },
        { id: 'c-1', title: 'one' },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.reloadConversationList(PROJECT);

    expect(chatApi.listConversations).toHaveBeenCalledWith(PROJECT, undefined, expect.anything());
    const listed = useConversationRuntime.getState().listByProject[PROJECT] ?? [];
    expect(listed.map((c) => c.id)).toEqual(['c-9', 'c-1']);
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(false);
  });

  it('gives a list that failed its last page a second chance', async () => {
    // 上一次翻页失败的那个标记,是「哨兵别再自己问了」的开关。它跨不过一次
    // 重新打开 —— 否则一个短到滚不动的列表在这次访问里就再也拉不到更早的了。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.listConversations).mockRejectedValue(new Error('offline'));
    await conversationRuntime.loadMoreConversations(PROJECT);
    expect(useConversationRuntime.getState().listMoreFailed[PROJECT]).toBe(true);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.reloadConversationList(PROJECT);

    expect(useConversationRuntime.getState().listMoreFailed[PROJECT]).toBe(false);
  });

  it('says the first page is on its way while it is', async () => {
    // 「一条都没有」和「还不知道有没有」是两句不同的话,而列表在这两种情况下
    // 手上都是空的。说错的那一句会让读者关掉列表、以为自己记错了。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    let land: (() => void) | undefined;
    vi.mocked(chatApi.listConversations).mockImplementation(
      () =>
        new Promise((resolve) => {
          land = () =>
            resolve({ conversations: [], hasMore: false } as unknown as Awaited<
              ReturnType<typeof chatApi.listConversations>
            >);
        }),
    );
    const reloading = conversationRuntime.reloadConversationList(PROJECT);
    expect(useConversationRuntime.getState().listLoading[PROJECT]).toBe(true);

    land?.();
    await reloading;

    expect(useConversationRuntime.getState().listLoading[PROJECT]).toBeUndefined();
  });

  it('says so while the panel is fetching that same first page', async () => {
    // openChat 拿回来的就是第一页,所以它在飞的时候,列表也正在路上 —— 同一个
    // 事实,一处记。
    vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
    void conversationRuntime.ensureLoaded(PROJECT);

    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().listLoading[PROJECT]).toBe(true),
    );
  });
});

describe('a page request left over from a visit that ended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('does not clear the marks belonging to the visit after it', async () => {
    // 旧请求落地时 `finally` 照跑,而它清的是按 project 记的账 —— 那本账现在
    // 属于新的一次访问。清掉之后:底部不再说「正在加载」,而请求确实还在飞;
    // 去重闸门也没了,末尾再进视野就会把同一页再要一遍。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    let failFirst: (() => void) | undefined;
    vi.mocked(chatApi.listConversations).mockImplementationOnce(
      () => new Promise((_r, reject) => (failFirst = () => reject(new Error('offline')))),
    );
    const abandoned = conversationRuntime.loadMoreConversations(PROJECT);

    conversationRuntime.leaveProject(PROJECT);
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    void conversationRuntime.loadMoreConversations(PROJECT);
    expect(useConversationRuntime.getState().listLoadingMore[PROJECT]).toBe(true);

    failFirst?.();
    await abandoned;

    expect(useConversationRuntime.getState().listLoadingMore[PROJECT]).toBe(true);
  });
});

describe('the name of the conversation on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('survives the list being replaced by a page it is not on', async () => {
    // 名字是会话自己的属性,而列表是分好页、按最近使用排的一个容器 —— 打开列表
    // 重取第一页时,一条很久没用过的当前会话根本不在那一页里。名字若只存在列表
    // 行上,它就跟着那一页一起没了,顶栏于是改口说这条会话没有名字。
    openAnswers([{ id: 'c-old', title: '很久以前那条' }], 'c-old', {
      hasMoreConversations: true,
    });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [
        { id: 'c-new1', title: '新的一' },
        { id: 'c-new2', title: '新的二' },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.reloadConversationList(PROJECT);

    expect(useConversationRuntime.getState().conversations['c-old']?.title).toBe('很久以前那条');
  });

  it('is what a rename just set, whether or not it is listed', async () => {
    openAnswers([{ id: 'c-old', title: '旧名字' }], 'c-old', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-other', title: '别的' }],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.reloadConversationList(PROJECT);

    vi.mocked(chatApi.renameConversation).mockResolvedValue({
      id: 'c-old',
      title: '新名字',
    } as unknown as Awaited<ReturnType<typeof chatApi.renameConversation>>);
    await conversationRuntime.rename(PROJECT, 'c-old', '新名字');

    expect(useConversationRuntime.getState().conversations['c-old']?.title).toBe('新名字');
  });

  it('is what the first message named it', async () => {
    // 走真实那条路:发一句话,服务器在流上回它给这条会话取的名字。
    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    await speakAndHearTitle('c-1', '第一句话', '第一句话');

    expect(useConversationRuntime.getState().conversations['c-1']?.title).toBe('第一句话');
  });
});

describe('two requests for the first page at once', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  it('keeps saying it is on its way until both are done', async () => {
    // 打开列表取第一页,中途读者把最后一条会话删了 —— 那条路会重开面板,也取
    // 第一页。记账按 project 记一份,先回来的那条若把它整个清掉,底部就不再说
    // 「正在加载」,而另一条确实还在飞。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockImplementation(() => new Promise(() => {}));
    void conversationRuntime.reloadConversationList(PROJECT);
    expect(useConversationRuntime.getState().listLoading[PROJECT]).toBe(true);

    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);
    openAnswers([{ id: 'c-2', title: 'a fresh one' }], 'c-2');
    await conversationRuntime.remove(PROJECT, 'c-1');

    // 那次重开已经回来了,但列表那趟还挂着 —— 第一页仍在路上。
    expect(useConversationRuntime.getState().listLoading[PROJECT]).toBe(true);
  });
});

describe('what a first page has to be told about', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    evictAllChatSessions();
  });

  /**
   * Hold a list answer back until the test lets it land.
   * @param answer - What the server will say.
   * @returns The release function.
   */
  function heldList(answer: { conversations: unknown[]; hasMore: boolean }): () => void {
    let release: () => void = () => undefined;
    vi.mocked(chatApi.listConversations).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = (): void =>
            resolve(answer as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
        }),
    );
    return () => release();
  }

  it('does not put a page that arrived meanwhile at the top', async () => {
    // 整片重取的语义是「从第一页重新全部加载」,所以更早的那些页退掉、列表
    // 回到第一页并重新说「还有更早的」,读者往下滚就能再要一次。要命的是
    // 另一种结果:翻页拿回来的是更早的会话、不是刚建的,把它们当成新建的排
    // 到最前,列表就不再是「最近使用在前」了。
    openAnswers(
      [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      'c-1',
      { hasMoreConversations: true },
    );
    await conversationRuntime.ensureLoaded(PROJECT);

    const landPage = heldList({
      conversations: [
        { id: 'c-3', title: 'three' },
        { id: 'c-4', title: 'four' },
      ],
      hasMore: false,
    });
    void conversationRuntime.loadMoreConversations(PROJECT);

    const landReload = heldList({
      conversations: [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      hasMore: true,
    });
    const reloading = conversationRuntime.reloadConversationList(PROJECT);

    landPage();
    await new Promise((r) => setTimeout(r, 0));
    landReload();
    await reloading;

    expect(
      (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id),
    ).toEqual(['c-1', 'c-2']);
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(true);
  });

  it('keeps a row made while the open call was out', async () => {
    // 打开 project 的那趟答复也是「一份组装于过去的答复」。它整片写列表,而
    // 这期间读者按了新建 —— 那一行在服务器组装答复时还不存在。
    let landOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((res) => {
          landOpen = (): void =>
            res({
              conversations: [{ id: 'c-1', title: 'one' }],
              hasMoreConversations: false,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as never);
        }),
    );
    const opening = conversationRuntime.ensureLoaded(PROJECT);
    await new Promise((r) => setTimeout(r, 5));

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as never);
    await conversationRuntime.startNew(PROJECT);

    landOpen?.();
    await opening;

    expect(listedIds()).toContain('c-new');
  });

  it('takes a name the answer knows and this end does not', async () => {
    // 另一个标签页改了名。重取正是为了看见这种改动 —— 名字住在会话上(不变量
    // 7),所以只写行的那份副本会让顶栏停在旧名字上,同一条会话当场两个名字,
    // 而且不会自愈:点它自己那一行不会重读。
    openAnswers([{ id: 'c-1', title: '旧名字' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-1', title: '新名字' }],
      hasMore: false,
    } as never);
    await conversationRuntime.reloadConversationList(PROJECT);

    expect(useConversationRuntime.getState().conversations['c-1']?.title).toBe('新名字');
    expect(useConversationRuntime.getState().listByProject[PROJECT]?.[0]?.title).toBe('新名字');
  });

  it('drops a page that answers about a list nobody holds any more', async () => {
    // 翻页是「接在手上这份列表后面」——游标取自它的末行。整片重取把那份列表
    // 换掉之后,那个游标描述的就是另一份列表了:照样接上去,中间会缺一段,而它
    // 带的 hasMore 还会把分页关掉,本次打开里再也拉不回来。
    openAnswers(
      [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      'c-1',
      { hasMoreConversations: true },
    );
    await conversationRuntime.ensureLoaded(PROJECT);

    const landPage = heldList({
      conversations: [{ id: 'c-9', title: 'nine' }],
      hasMore: false,
    });
    void conversationRuntime.loadMoreConversations(PROJECT);

    const landReload = heldList({
      conversations: [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      hasMore: true,
    });
    const reloading = conversationRuntime.reloadConversationList(PROJECT);

    landReload();
    await reloading;
    landPage();
    await new Promise((r) => setTimeout(r, 0));

    expect(
      (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id),
    ).toEqual(['c-1', 'c-2']);
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(true);
  });

  it('drops a page about the list that a re-open replaced', async () => {
    // 重开那条落地点跟重取是同一件事:它也整片换掉列表,所以在飞的那一页的游标
    // 同样指着一份没人再拿着的列表。撤回时这行调用被顺手带走过一次,而当时两条
    // 翻页测试钉的都是重取那一处,重开这处一条都没有。
    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1', { hasMoreConversations: true });
    await conversationRuntime.ensureLoaded(PROJECT);

    const landPage = heldList({
      conversations: [{ id: 'c-9', title: 'nine' }],
      hasMore: false,
    });
    void conversationRuntime.loadMoreConversations(PROJECT);

    // 删掉手上唯一那条 —— 没有下一条可落,于是走重开而不是切换。
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof chatApi.deleteConversation>>,
    );
    openAnswers([{ id: 'c-2', title: null }], 'c-2', { hasMoreConversations: true });
    await conversationRuntime.remove(PROJECT, 'c-1');

    landPage();
    await new Promise((r) => setTimeout(r, 0));

    expect(
      (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id),
    ).toEqual(['c-2']);
    // 那一页带的 hasMore 是 false。接受它就等于本次打开里再也拉不到更早的了。
    expect(useConversationRuntime.getState().listHasMore[PROJECT]).toBe(true);
  });

  it('does not fetch a page the reader never scrolled to', async () => {
    // 丢掉那份过期答复之后不再自己补一次:读者「滚到了末尾」这件事说的是**那份**
    // 列表的末尾,而它已经被换掉了。替它补一页,等于把他从没要过的行塞进新列表。
    // 下一次要更早的,由他滚到新列表的末尾来决定。
    openAnswers(
      [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      'c-1',
      { hasMoreConversations: true },
    );
    await conversationRuntime.ensureLoaded(PROJECT);

    const landPage = heldList({
      conversations: [{ id: 'c-9', title: 'nine' }],
      hasMore: false,
    });
    void conversationRuntime.loadMoreConversations(PROJECT);

    const landReload = heldList({
      conversations: [
        { id: 'c-1', title: 'one' },
        { id: 'c-2', title: 'two' },
      ],
      hasMore: true,
    });
    const reloading = conversationRuntime.reloadConversationList(PROJECT);

    landReload();
    await reloading;
    const askedSoFar = vi.mocked(chatApi.listConversations).mock.calls.length;
    landPage();
    await new Promise((r) => setTimeout(r, 0));

    expect(
      (useConversationRuntime.getState().listByProject[PROJECT] ?? []).map((c) => c.id),
    ).toEqual(['c-1', 'c-2']);
    expect(vi.mocked(chatApi.listConversations).mock.calls.length).toBe(askedSoFar);
  });

  it('stops saying the first page is on its way when the last one out was abandoned', async () => {
    // 计数无条件配对(这是对的),所以把它减到零的那一趟可能属于一次已经被丢
    // 下的访问。清那句「正在加载」的判据是计数归零,不是「谁减的」—— 挂在
    // 访问上就会出现一个谁都不清的格子。
    let landFirst: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementationOnce(
      () =>
        new Promise((res) => {
          landFirst = (): void =>
            res({
              conversations: [{ id: 'c-1', title: 'one' }],
              hasMoreConversations: false,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as never);
        }),
    );
    void conversationRuntime.ensureLoaded(PROJECT);
    await new Promise((r) => setTimeout(r, 0));
    conversationRuntime.leaveProject(PROJECT);

    openAnswers([{ id: 'c-2', title: 'two' }], 'c-2');
    await conversationRuntime.ensureLoaded(PROJECT);

    landFirst?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(useConversationRuntime.getState().listLoading[PROJECT]).toBeUndefined();
  });

  it('can be asked again after a visit was abandoned mid-open', async () => {
    // 那趟被丢下的打开请求落地时不该替新访问收尾,但记账的增减必须配对 ——
    // 只增不减,去重的闸门就永远关着,列表再也不会重新取。
    let settleOpen: () => void = () => undefined;
    vi.mocked(chatApi.openChat).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleOpen = (): void =>
            resolve({
              conversations: [{ id: 'c-1', title: 'one' }],
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
              hasMoreConversations: false,
            } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
        }),
    );
    void conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.leaveProject(PROJECT);
    settleOpen();
    await new Promise((r) => setTimeout(r, 0));

    openAnswers([{ id: 'c-1', title: 'one' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-1', title: 'one' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.reloadConversationList(PROJECT);

    expect(vi.mocked(chatApi.listConversations)).toHaveBeenCalledTimes(1);
  });
});
