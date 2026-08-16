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

describe('a conversation started while the project is still opening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('stays in the list the reader can choose from', async () => {
    // 开聊天那一页列表是「新建之前」查的，不含刚建的这条。它落地时如果原样
    // 覆写本地列表，这条会话就从抽屉里消失了 —— 人在里面，列表里却没有它。
    let releaseOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOpen = () =>
            resolve({
              conversations: [{ id: 'c-1', title: 'one' }],
              hasMoreConversations: false,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
        }),
    );
    const opening = conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);
    await conversationRuntime.startNew(P);

    releaseOpen?.();
    await opening;

    const listed = useConversationRuntime.getState().listByProject[P] ?? [];
    expect(listed.map((c) => c.id)).toContain('c-new');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new');
  });
});

describe('a landing that gets overtaken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not leave the panel saying it is loading for ever', async () => {
    // 删除把面板置成 loading 再去读下一条。这一趟被后来的新建顶掉之后，
    // 若新建自己也失败，就没有人再写这个状态了 —— 骨架永远转下去，
    // 既不出内容也不出失败蒙版，屏幕上没有任何出口。
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);
    let releaseRead: (() => void) | undefined;
    vi.mocked(chatApi.readConversation).mockImplementation(
      () => new Promise((resolve) => (releaseRead = () => resolve({} as never))),
    );
    const removing = conversationRuntime.remove(P, 'c-1');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await conversationRuntime.startNew(P);
    releaseRead?.();
    await removing;

    expect(useConversationRuntime.getState().openStatus[P]).not.toBe('loading');
  });
});

describe('a page that arrives after the list has shifted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('never lists the same conversation twice', async () => {
    // 另一个标签页新建了一条,服务端的排序整体后移一位,于是按本地行数算出来
    // 的偏移量取回一条本地已经有的会话。两行同一个 id,React 的 key 就重了。
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    useConversationRuntime.setState((s) => ({
      listHasMore: { ...s.listHasMore, [P]: true },
    }));
    await conversationRuntime.ensureLoaded(P);
    useConversationRuntime.setState((s) => ({
      listHasMore: { ...s.listHasMore, [P]: true },
    }));

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-2', title: 'two' }, { id: 'c-3', title: 'three' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.loadMoreConversations(P);

    const ids = (useConversationRuntime.getState().listByProject[P] ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['c-1', 'c-2', 'c-3']);
  });
});

describe('coming back to a project that had more than one page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not think there is a next page before the first one has arrived', async () => {
    opens([{ id: 'c-1', title: 'one' }]);
    await conversationRuntime.ensureLoaded(P);
    useConversationRuntime.setState((s) => ({
      listHasMore: { ...s.listHasMore, [P]: true },
    }));

    conversationRuntime.leaveProject(P);

    expect(useConversationRuntime.getState().listHasMore[P]).toBeUndefined();
  });
});

describe('a conversation started before the project has finished opening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('keeps the conversations that were already there', async () => {
    // 那份答复是新建之前查的,所以它不含新建的这条 —— 但它含着别的全部。
    // 整份丢掉是把「列表少一行」换成了「列表只剩一行」,而且连「还有下一页」
    // 也一起丢了,翻页这条补救路就此焊死。
    let releaseOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOpen = () =>
            resolve({
              conversations: [
                { id: 'c-1', title: 'one' },
                { id: 'c-2', title: 'two' },
              ],
              hasMoreConversations: true,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
        }),
    );
    const opening = conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);
    await conversationRuntime.startNew(P);

    releaseOpen?.();
    await opening;

    const listed = useConversationRuntime.getState().listByProject[P] ?? [];
    expect(listed.map((c) => c.id)).toEqual(['c-new', 'c-1', 'c-2']);
    expect(useConversationRuntime.getState().listHasMore[P]).toBe(true);
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new');
  });
});

describe('the landing after a delete, when the reader has moved on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not black out a conversation the reader picked themselves', async () => {
    // 删除的落点失败了,说明「删完该显示哪条」这件事没办成。但读者这时已经
    // 自己挑了一条、正看着它 —— 把整列打成不可读,是拿一件已经不作数的事
    // 去盖掉一件正好好的事。
    opens([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: 'three' },
    ]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);
    let failNext: (() => void) | undefined;
    vi.mocked(chatApi.readConversation).mockImplementationOnce(
      () => new Promise((_r, reject) => (failNext = () => reject(new Error('offline')))),
    );
    const removing = conversationRuntime.remove(P, 'c-1');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-3', title: 'three' },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    await conversationRuntime.switchTo(P, 'c-3');

    failNext?.();
    await removing;

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-3');
    expect(useConversationRuntime.getState().openStatus[P]).toBe('ready');
  });
});

describe('a new conversation that could not be created', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not black out a chat that opened perfectly well', async () => {
    // 失败的是创建,不是读取。会话列表这一刻就在手里,而蒙版说的是
    // 「你的会话读不回来」—— 它盖住的正是那句真正该被读到的提示。
    let releaseOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOpen = () =>
            resolve({
              conversations: [{ id: 'c-1', title: 'one' }],
              hasMoreConversations: false,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
        }),
    );
    const opening = conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await conversationRuntime.startNew(P);

    releaseOpen?.();
    await opening;

    expect(useConversationRuntime.getState().openStatus[P]).toBe('ready');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-1');
  });

  it('lists both when two are asked for in a row', async () => {
    // 两次按下就是两次创建,服务端也确实建了两条。「别落在第一条上」和
    // 「别列出第一条」是两件事,提前返回把它们合成了一件。
    opens([{ id: 'c-1', title: 'one' }]);
    await conversationRuntime.ensureLoaded(P);

    const made: Array<() => void> = [];
    vi.mocked(chatApi.createConversation).mockImplementation(
      (_p) =>
        new Promise((resolve) => {
          const n = made.length + 1;
          made.push(() => resolve({ id: `c-new-${n}`, title: null } as never));
        }),
    );
    const first = conversationRuntime.startNew(P);
    const second = conversationRuntime.startNew(P);
    made[0]?.();
    made[1]?.();
    await Promise.all([first, second]);

    const ids = (useConversationRuntime.getState().listByProject[P] ?? []).map((c) => c.id);
    expect(ids).toContain('c-new-1');
    expect(ids).toContain('c-new-2');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new-2');
  });
});

describe('the window between deleting a conversation and landing on the next', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not read the gate through a conversation that is gone', async () => {
    // 「一个 project 一次一轮」这道闸门是顺着当前会话指针读出来的。指针还指着
    // 一条已经删掉的会话时,读到的是空,而空被判成「什么都没在跑」—— 于是这
    // 段时间里连按发送就是两轮,两轮都要花钱。
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);
    vi.mocked(chatApi.readConversation).mockImplementation(() => new Promise(() => {}));
    void conversationRuntime.remove(P, 'c-1');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    const state = useConversationRuntime.getState();
    expect(state.currentByProject[P]).toBeUndefined();
    expect(state.conversations['c-1']).toBeUndefined();
  });
});

describe('a press that fails while an older answer is still on its way', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('lets that answer land, rather than leaving a skeleton turning', async () => {
    // 「+」失败之后它就不再算数了,还在路上的那个打开请求重新成为读者等的
    // 那一个。少了这一步,面板会永远停在骨架上:没有内容、没有蒙版,也就
    // 没有任何再问一次的出口。
    let releaseOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOpen = () =>
            resolve({
              conversations: [{ id: 'c-1', title: 'one' }],
              hasMoreConversations: false,
              current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
            } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
        }),
    );
    const opening = conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await conversationRuntime.startNew(P);

    releaseOpen?.();
    await opening;

    expect(useConversationRuntime.getState().openStatus[P]).toBe('ready');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-1');
  });

  it('settles the panel when nothing else is on its way', async () => {
    // 反过来:没有别人在飞了,最后离场的那个就得把面板带到一个有出口的
    // 状态 —— 蒙版加重新加载,而不是一个永远转下去的骨架。
    vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
    void conversationRuntime.ensureLoaded(P);
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    vi.mocked(chatApi.createConversation).mockRejectedValue(new Error('offline'));
    await conversationRuntime.startNew(P);

    // 打开那趟还挂着,所以还有人在飞,这时候不该收尾。
    expect(useConversationRuntime.getState().openStatus[P]).toBe('loading');

    conversationRuntime.leaveProject(P);
    expect(useConversationRuntime.getState().openStatus[P]).toBeUndefined();
  });
});

describe('the landing after deleting the only conversation there was', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not black out the conversation the reader started meanwhile', async () => {
    // 跟上面那条「删完还有下一条可读」是同一件事,走的是另一条分支:一条不剩时
    // 要开一条新的,而这一趟失败了。读者这时已经自己按了新建、正看着那一条,
    // 拿一件不作数的事去盖掉一件正好好的事,两条分支上都不对。
    opens([{ id: 'c-1', title: 'one' }]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);
    let failOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementationOnce(
      () => new Promise((_r, reject) => (failOpen = () => reject(new Error('offline')))),
    );
    const removing = conversationRuntime.remove(P, 'c-1');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);
    await conversationRuntime.startNew(P);

    failOpen?.();
    await removing;

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-new');
    expect(useConversationRuntime.getState().openStatus[P]).toBe('ready');
  });
});

describe('an open that fails while a later press is still out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('leaves the panel waiting rather than saying it cannot be read', async () => {
    // 打开这一趟没成,但读者按下的新建还在路上。面板此刻的实情是「还在等」,
    // 不是「读不回来」—— 写成读不回来会闪一层蒙版,而它马上要被盖掉。
    let failOpen: (() => void) | undefined;
    vi.mocked(chatApi.openChat).mockImplementation(
      () => new Promise((_r, reject) => (failOpen = () => reject(new Error('offline')))),
    );
    const opening = conversationRuntime.ensureLoaded(P);
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    vi.mocked(chatApi.createConversation).mockImplementation(() => new Promise(() => {}));
    void conversationRuntime.startNew(P);

    failOpen?.();
    await opening;

    expect(useConversationRuntime.getState().openStatus[P]).toBe('loading');
  });
});

describe('a conversation started when the first page never arrived', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('leaves the list able to fetch what the failed open did not', async () => {
    // 打开没成,列表一行都没到;接着新建成功,列表里于是只有这一行。这一行之前
    // 还有什么无人知道,而「不知道」不等于「没有」—— 说成没有,读者滑到底也
    // 再拉不回那些会话了。
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    await conversationRuntime.ensureLoaded(P);
    expect(useConversationRuntime.getState().openStatus[P]).toBe('failed');

    vi.mocked(chatApi.createConversation).mockResolvedValue({
      id: 'c-new',
      title: null,
      updatedAt: '2026-08-16T00:00:00.000Z',
    } as unknown as Awaited<ReturnType<typeof chatApi.createConversation>>);
    await conversationRuntime.startNew(P);

    vi.mocked(chatApi.listConversations).mockResolvedValue({
      conversations: [{ id: 'c-old', title: 'older' }],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.listConversations>>);
    await conversationRuntime.loadMoreConversations(P);

    expect(chatApi.listConversations).toHaveBeenCalled();
    expect(useConversationRuntime.getState().listByProject[P]?.map((c) => c.id)).toEqual([
      'c-new',
      'c-old',
    ]);
  });
});

describe('a visit that was abandoned while its request was still out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not let the abandoned request settle the visit that replaced it', async () => {
    // 读者嫌慢,退出去又进来。头一趟的答复终于回来时,它手里那个号必须还是
    // 它自己的 —— 号要是从头发过,这趟离场的请求收尾时结算的就是新那趟,
    // 而新那趟的答复正在路上、服务器好好的,面板却已经黑了。
    let failFirst: (() => void) | undefined;
    let landSecond: (() => void) | undefined;
    vi.mocked(chatApi.openChat)
      .mockImplementationOnce(
        () => new Promise((res) => {
          failFirst = () => res({
            conversations: [],
            hasMoreConversations: false,
            current: { conversation: { id: 'c-1', title: 'one' }, messages: [], hasMore: false },
          } as never);
        }),
      )
      .mockImplementationOnce(
        () => new Promise((res) => {
          landSecond = () => res({
            conversations: [{ id: 'c-2', title: 'two' }],
            hasMoreConversations: false,
            current: { conversation: { id: 'c-2', title: 'two' }, messages: [], hasMore: false },
          } as never);
        }),
      );

    const abandoned = conversationRuntime.ensureLoaded(P);
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );
    conversationRuntime.leaveProject(P);

    const current = conversationRuntime.ensureLoaded(P);
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().openStatus[P]).toBe('loading'),
    );

    failFirst?.();
    await abandoned;
    expect(useConversationRuntime.getState().openStatus[P]).toBe('loading');

    landSecond?.();
    await current;

    expect(useConversationRuntime.getState().openStatus[P]).toBe('ready');
    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-2');
  });
});

describe('pressing send while a switch is still on its way', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not write into the conversation being left', async () => {
    // 读者点了另一条,屏幕上还没换过去。这时候按发送,他以为是在跟刚点的那条
    // 说话 —— 写进正在离开的那条,他的话连同回复会随切换落地一起消失,而那一
    // 轮还在后台按他的账跑。
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    let landSwitch: (() => void) | undefined;
    vi.mocked(chatApi.readConversation).mockImplementationOnce(
      () => new Promise((res) => {
        landSwitch = () => res({
          conversation: { id: 'c-2', title: 'two' }, messages: [], hasMore: false,
        } as never);
      }),
    );
    const switching = conversationRuntime.switchTo(P, 'c-2');
    await new Promise((r) => setTimeout(r, 5));

    await conversationRuntime.send(P, 'hello');

    expect(chatApi.streamMessage).not.toHaveBeenCalled();

    landSwitch?.();
    await switching;
  });
});
