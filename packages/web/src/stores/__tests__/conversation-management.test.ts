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
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';

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
 * 说一句话,并让服务端在开启这一轮的事件里带回会话的名字。
 *
 * 走的是真实那条路:名字是服务端在 `chat_turn_started` 上说的,前端据此更新
 * 列表。测试直接调那个内部函数就绕开了这条线,而线断了没有任何测试会红。
 * @param conversationId - 说话的那条会话。
 * @param said - 说了什么。
 * @param title - 服务端回的名字。
 */
async function speakAndHearTitle(
  conversationId: string,
  said: string,
  title: string,
): Promise<void> {
  let handlers: { onEvent: (e: SSEEventEnvelope) => void } | undefined;
  vi.mocked(chatApi.streamMessage).mockImplementation((_input, h) => {
    handlers = h as typeof handlers;
    return new Promise<void>(() => {});
  });
  void conversationRuntime.send(PROJECT, said);
  await vi.waitFor(() => expect(handlers).toBeDefined());
  handlers!.onEvent({
    event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
    data: { messages: [], hasMore: false, title },
  } as unknown as SSEEventEnvelope);
  conversationRuntime.stopTurn(conversationId);
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
          content: 'said in the other one',
          ts: '2026-08-15T00:00:00Z',
          turnIndex: 3,
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(currentId()).toBe('c-2');
    const held = useConversationRuntime.getState().conversations['c-2'];
    expect(held?.messages.map((m) => m.content)).toEqual(['said in the other one']);
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
    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a sentence');
    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.startNew(PROJECT);

    expect(currentId()).toBe('c-1');
    expect(listedIds()).toEqual(['c-1']);
    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('half a sentence');
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
  });

  it('holds one draft per conversation, not one for the panel', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');

    expect(conversationRuntime.draftOf(PROJECT, 'c-2')).toBe('');
  });

  it('gives back what was left in a conversation on returning to it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }, { id: 'c-2', title: 'second' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', title: 'second' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);

    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');
    await conversationRuntime.switchTo(PROJECT, 'c-2');
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-1', title: 'first' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    await conversationRuntime.switchTo(PROJECT, 'c-1');

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('half a thought');
  });

  it('forgets every draft in a project once the reader leaves it', async () => {
    openAnswers([{ id: 'c-1', title: 'first' }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);
    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a thought');

    conversationRuntime.leaveProject(PROJECT);

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('');
  });
});

describe('what the list says about when a conversation was last used', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
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
  });

  it('holds nothing, because the box is not open for typing then', async () => {
    // 打开面板那一趟往返里输入框是只读的 —— 它跟切换会话走同一道闸门。所以
    // 「还没有会话可归」这种草稿产生不出来,也就不该有一个键去存它:留着那套
    // 转交的机制,就是留一段谁也走不到的代码。
    conversationRuntime.setDraft(PROJECT, undefined, 'nowhere to put this');

    openAnswers([{ id: 'c-1', title: null }], 'c-1');
    await conversationRuntime.ensureLoaded(PROJECT);

    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('');
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
    conversationRuntime.setDraft(PROJECT, 'c-1', 'half a sentence');

    expect(conversationRuntime.draftOf(PROJECT, 'c-2')).toBe('');
    expect(conversationRuntime.draftOf(PROJECT, 'c-1')).toBe('half a sentence');
  });
});

describe('a list longer than one page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
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
