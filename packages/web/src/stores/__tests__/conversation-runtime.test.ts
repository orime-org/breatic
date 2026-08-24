// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 一条会话在没人渲染它的时候都做些什么。
 *
 * 面板那一半在面板那儿测；这里钉的是没有面板参与的那一半 —— 哪一条会话在
 * 屏幕上、列表说了什么、历史往回读到哪儿、以及一次访问结束之后那些还在飞的
 * 请求不许再改变任何东西。
 *
 * 一轮对话本身不在这里了：它归 `stores/chat-sessions`，测试在
 * `chat-sessions.test.ts` / `turn-mishaps.test.ts` / `heartbeat-watchdog.test.ts`。
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
  },
}));

import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import {
  conversationRuntime,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions, sendInSession } from '@web/stores/chat-sessions';

/** 这一轮请求拿到的中止信号。 */
let sent: AbortSignal | null | undefined;

/**
 * 在一条会话里开一轮，并等到请求真的出去了。
 * @param conversationId - 哪一条。
 */
async function aTurnIsRunningIn(conversationId: string): Promise<void> {
  chatSessionFor({
    projectId: 'p-1',
    conversationId,
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
  });
  void sendInSession(conversationId, '一个要答很久的问题');
  await vi.waitFor(() => {
    expect(sent).toBeDefined();
  });
}

/**
 * Answer the open call with one conversation and one earlier turn.
 * @param opts - What the answer says
 * @param opts.hasMore - The conversation reaches back further than this page
 */
function openChatAnswers({ hasMore = false }: { hasMore?: boolean } = {}): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c-1' }],
    current: {
      conversation: { id: 'c-1' },
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'earlier' }],
          metadata: { turnIndex: 7, ts: '2026-08-13T00:00:00Z' },
        },
      ],
      hasMore,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * The conversation as the store holds it.
 * @returns Its runtime entry, or undefined once it has been dropped
 */
function conversation() {
  return useConversationRuntime.getState().conversations['c-1'];
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  evictAllChatSessions();
  sent = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent = init?.signal;
      // 永不结束，跟真的那条一样：socket 不关它就不结束。一调用就 resolve 的
      // 替身会当场跑完这一轮的收尾，而收尾正是这些用例要看的东西。
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('saying something when the chat has not opened', () => {
  it('opens one and hands it back, rather than refusing', async () => {
    // 项目打开的时候聊天没读出来 —— 网络断了,或者服务器不在。这拦不住读者
    // 打字按发送,而按发送正该让他动起来。
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    openChatAnswers();
    const writeInto = await conversationRuntime.conversationForSending('p-1');

    // 路上把会话开出来了,并且答的就是那一条。
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
    expect(writeInto).toBe('c-1');
  });

  it('says so once when it cannot be opened either, and leaves the screen alone', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));

    const writeInto = await conversationRuntime.conversationForSending('p-1');
    stop();

    // 一行字,别的什么都没发生:没有会话可写,所以面板一个字都不发出去,
    // 而读者的话还在框里 —— 没有任何东西把它拿走过。
    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: null, kind: 'network' })]);
    expect(writeInto).toBeUndefined();
  });
});

describe('pressing send twice while the conversation is still being opened', () => {
  it('opens one conversation, not two', async () => {
    // 第一次按发送要先把会话开出来,那是一整个来回。读者看不到任何动静,
    // 又按了一次 —— 人就是这么做的。
    let openIt: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        openIt = resolve;
      }),
    );

    const first = conversationRuntime.conversationForSending('p-1');
    const second = conversationRuntime.conversationForSending('p-1');
    openIt({
      conversations: [{ id: 'c-1' }],
      current: { conversation: { id: 'c-1' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    // 开出两条,第二次按下就会落进一条读者从没看见过的会话里。
    expect(await first).toBe('c-1');
    expect(await second).toBe('c-1');
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
  });

  it('is already waiting from the press, not from the conversation', async () => {
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));

    void conversationRuntime.conversationForSending('p-1');
    await vi.waitFor(() => {
      expect(chatApi.openChat).toHaveBeenCalled();
    });

    // 面板画的那个等待指示读的是这个。留到会话出现才置上,整个打开请求
    // 就是一个挂着可点发送按钮的窗口。
    expect(useConversationRuntime.getState().sendingByProject['p-1']).toBe(true);
  });
});

describe('what the message column is told while a chat is re-opened', () => {
  it('says it is trying again when a chat that could not be read is re-opened', async () => {
    // 打开失败之后,屏幕上没有会话 —— 蒙版盖着整列。所以再打开一次不会
    // 拿走任何东西,而说一句「在读了」正是重试该有的样子:蒙版让位给等待,
    // 再失败一次蒙版再回来。
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));
    void conversationRuntime.ensureLoaded('p-1');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));

    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('loading');
  });

});

describe('one line per failed request, however many callers were waiting', () => {
  it('says it once, not once per caller', async () => {
    // 面板挂载时问一次聊天。读者在它落地之前打字按了发送,而发送问的是
    // 同一件事 —— 它加入那个已经在飞的请求,不另发一个。一个请求失败了,
    // 欠一行字。
    let refuse: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((_res, rej) => {
        refuse = rej;
      }),
    );
    const mounting = conversationRuntime.ensureLoaded('p-1');

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    const sending = conversationRuntime.conversationForSending('p-1');
    refuse(new Error('offline'));
    await mounting;
    await sending;
    stop();

    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(told).toHaveLength(1);
  });
});

describe('an answer that did not come from our server', () => {
  it('is not passed off as a sentence written for the reader', async () => {
    // 网关超时会用它自己的 body 答话,里面没有我们的任何东西 —— 库留下的是
    // 写给开发者看的英文,从来没过 `t()`。
    //
    // 一轮对话那一侧的同一件事在 `turn-mishaps.test.ts`:那儿判的是 SDK 抛出
    // 来的东西,这儿判的是 axios 抛出来的,两个传输层两套判据。
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(
      new ApiException({ status: 502, message: 'Request failed with status code 502' }),
    );

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.ensureLoaded('p-1');
    stop();

    expect(told).toEqual([
      expect.objectContaining({ projectId: 'p-1', conversationId: null, kind: 'network' }),
    ]);
  });

  it('still passes on the one the server did write', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(
      new ApiException({ status: 402, message: '积分不足', fromServer: true }),
    );

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.ensureLoaded('p-1');
    stop();

    expect(told).toEqual([expect.objectContaining({ kind: 'server', message: '积分不足' })]);
  });
});

describe('leaving the project', () => {
  it('stops the turn and forgets the conversation', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    await aTurnIsRunningIn('c-1');

    conversationRuntime.leaveProject('p-1');

    // Stopped, not abandoned: once the project is off the screen there is no
    // stop button anywhere for this turn, so leaving it running would keep
    // the model going on the user's account with the switch out of reach.
    expect(sent?.aborted).toBe(true);
    // And forgotten, because nothing keyed by conversation ever drops itself
    // -- the messages would sit in memory until the page closed, and loading
    // earlier lets a reader make that list as long as they like.
    expect(conversation()).toBeUndefined();
    expect(useConversationRuntime.getState().currentByProject['p-1']).toBeUndefined();
  });

  it('lets the project be opened again afterwards', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.leaveProject('p-1');

    await conversationRuntime.ensureLoaded('p-1');
    expect(conversation()?.messages).toHaveLength(1);
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
  });
});

describe('loading what came before', () => {
  /**
   * 让服务端把这条会话整个重新交一遍,新的那一页从某一轮开始。
   *
   * 一条会话的历史被整片换掉,今天只有一条路:重新读它 —— 切走再切回来、
   * 重开项目、或者删掉当前这条之后落到别处。读者拉上来的更早那些跟着一起
   * 换掉了。
   * @param firstTurnIndex - 新的那一页最老的那一轮。
   */
  async function theConversationIsReadAgainFrom(firstTurnIndex: number): Promise<void> {
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-1' },
      messages: [
        {
          id: `m${firstTurnIndex}`,
          role: 'user',
          parts: [{ type: 'text', text: 'much later' }],
          metadata: { turnIndex: firstTurnIndex, ts: '2026-08-18T00:00:00Z' },
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    // 经另一条会话绕一圈:切到屏幕上已经在的那一条会提前返回,而它本来就
    // 不该为此再问服务端一次。
    vi.mocked(chatApi.readConversation).mockImplementationOnce(
      async () =>
        ({
          conversation: { id: 'c-2' },
          messages: [],
          hasMore: false,
        }) as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>,
    );
    await conversationRuntime.switchTo('p-1', 'c-2');
    await conversationRuntime.switchTo('p-1', 'c-1');
  }

  it('puts it at the head, leaving the turn in flight alone', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    await aTurnIsRunningIn('c-1');

    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'oldest' }],
          metadata: { turnIndex: 3, ts: '2026-08-12T00:00:00Z' },
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);

    await conversationRuntime.loadEarlier('c-1');
    // Asked from where the loaded history reaches back to, not from the
    // newest end: the cursor is the oldest turn on screen.
    expect(chatApi.messagesBefore).toHaveBeenCalledWith('c-1', 7, expect.any(AbortSignal));

    // 两个写者,两端。更早的那一页接在头上,而尾端那一轮在会话实例里照常跑
    // 着 —— 这一页落地不该碰它。
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(conversation()?.hasMore).toBe(false);
    expect(sent?.aborted).toBe(false);
  });

  it('会话实例还在时，重新读它不许把「还能往前翻吗」覆盖回去', async () => {
    // 这三样(列表、还能不能往前翻、翻到哪一轮了)是一体的:读者已经把这条
    // 会话翻到了头,而服务端交回来的永远是最新那一页、它自己那份 `hasMore`
    // 说的是「这一页之前还有」。只保住列表、让这一个跟着服务端走,屏幕上就
    // 会重新出现一个「加载更早」按钮,按下去请求的是列表里已经有的那一页。
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    await aTurnIsRunningIn('c-1');

    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'oldest' }],
          content: 'oldest',
          ts: '2026-08-01T00:00:00Z',
          turnIndex: 0,
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await conversationRuntime.loadEarlier('c-1');
    expect(conversation()?.hasMore).toBe(false);

    // 服务端这次交回来的那一页自称还有更早的。
    await theConversationIsReadAgainFrom(60);

    expect(conversation()?.hasMore).toBe(false);
  });

  it('drops a page that no longer joins onto the list', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');

    let landPage: (p: Awaited<ReturnType<typeof chatApi.messagesBefore>>) => void = () => {};
    vi.mocked(chatApi.messagesBefore).mockReturnValueOnce(
      new Promise((resolve) => {
        landPage = resolve;
      }),
    );
    // Asked from turn 7, which is where the list reached back to.
    const earlier = conversationRuntime.loadEarlier('c-1');

    // 它还没答话,这条会话就被重新读了一遍 —— 服务端给的那一页从第 60 轮
    // 开始。
    await theConversationIsReadAgainFrom(60);

    landPage({
      messages: [
        {
          id: 'm5',
          role: 'user',
          parts: [{ type: 'text', text: 'turn five' }],
          content: 'turn five',
          ts: '2026-08-01T00:00:00Z',
          turnIndex: 5,
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await earlier;

    // This page was asked for from a list that no longer exists. Putting it at
    // the head of the new one leaves turns 8 to 59 missing with nothing on
    // screen saying so -- and moves the cursor past them, so no press could
    // ever ask for them again.
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['m60']);
    expect(conversation()?.oldestLoadedTurn).toBe(60);
  });

  it('asks again when the list has moved on, rather than joining the old request', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');

    // The first page, asked for from turn 7, never answers. The second is
    // answered, so what is being watched is whether a second one is made.
    vi.mocked(chatApi.messagesBefore).mockImplementation((_id, beforeTurn) =>
      beforeTurn === 7
        ? new Promise(() => {})
        : Promise.resolve({
          messages: [
            {
              id: 'm59',
              role: 'user',
              parts: [{ type: 'text', text: 'turn fifty-nine' }],
              content: 'turn fifty-nine',
              ts: '2026-08-13T00:00:00Z',
              turnIndex: 59,
            },
          ],
          hasMore: true,
        } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>),
    );
    void conversationRuntime.loadEarlier('c-1');

    // 这条会话被重新读了一遍,服务端给的那一页从第 60 轮开始。
    await theConversationIsReadAgainFrom(60);

    void conversationRuntime.loadEarlier('c-1');

    // Joining the one still on its way would be waiting on an answer that is
    // going to be dropped -- it was asked from a list that no longer exists.
    // The reader pressed a button and nothing at all would happen.
    await vi.waitFor(() => expect(chatApi.messagesBefore).toHaveBeenCalledTimes(2));
    expect(chatApi.messagesBefore).toHaveBeenLastCalledWith('c-1', 60, expect.any(AbortSignal));
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['m59', 'm60']);
  });

  it('does nothing when there is nothing older', async () => {
    openChatAnswers({ hasMore: false });
    await conversationRuntime.ensureLoaded('p-1');

    await conversationRuntime.loadEarlier('c-1');

    expect(chatApi.messagesBefore).not.toHaveBeenCalled();
  });

  it('fetches one page however many times the button is pressed', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'oldest' }],
          content: 'oldest',
          ts: '2026-08-12T00:00:00Z',
          turnIndex: 3,
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);

    // Both before either lands, which is what a second press is.
    await Promise.all([
      conversationRuntime.loadEarlier('c-1'),
      conversationRuntime.loadEarlier('c-1'),
    ]);

    // Two requests would answer with the same page and both would write it to
    // the head, so the reader would be shown every earlier message twice.
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(1);
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['m0', 'm1']);
  });

});

describe('an answer that arrives after the reader has left', () => {
  it('is dropped, rather than putting the project back', async () => {
    let answer: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const opened = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    answer({
      conversations: [{ id: 'c-1' }],
      current: { conversation: { id: 'c-1' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    await opened;

    // Nothing clears these a second time: leaving already ran, and it is the
    // only thing that clears them. Written now, they would stay for the life
    // of the page -- a conversation for a project nobody is looking at.
    expect(conversation()).toBeUndefined();
    expect(useConversationRuntime.getState().currentByProject['p-1']).toBeUndefined();
    expect(useConversationRuntime.getState().openStatus['p-1']).toBeUndefined();
  });

  it('is dropped when it is a refusal too', async () => {
    let refuse: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }) as ReturnType<typeof chatApi.openChat>,
    );
    const opened = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    refuse(new Error('gone'));
    await opened;

    // Otherwise the project comes back holding one thing: the news that it
    // failed, about a request made for a screen that is no longer there.
    expect(useConversationRuntime.getState().openStatus['p-1']).toBeUndefined();
  });
});

describe('a request left over from a previous visit to the project', () => {
  /**
   * Answer the open call with one conversation holding the given messages.
   * @param texts - What has been said in it, oldest first
   * @param hasMore - The conversation reaches back further than this page
   * @returns That answer, in the shape the api hands out
   */
  function answer(texts: string[], hasMore = false): Awaited<ReturnType<typeof chatApi.openChat>> {
    return {
      conversations: [{ id: 'c-1' }],
      current: {
        conversation: { id: 'c-1' },
        messages: texts.map((text, i) => ({
          id: `srv-${text}`,
          role: 'user',
          parts: [{ type: 'text', text }],
          metadata: { turnIndex: 40 + i, ts: '2026-08-13T00:00:00Z' },
        })),
        hasMore,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>;
  }

  it('does not land on the conversation the next visit is reading', async () => {
    let landFirstVisit: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        landFirstVisit = resolve;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    // Slow to open, which is the reason the reader backs out and comes in
    // again -- so this is not an unusual sequence, it is the usual answer to
    // a project that is taking too long.
    conversationRuntime.leaveProject('p-1');
    vi.mocked(chatApi.openChat).mockResolvedValueOnce(answer(['hello again']));
    await conversationRuntime.ensureLoaded('p-1');

    await aTurnIsRunningIn('c-1');

    landFirstVisit(answer(['hello again', 'my question']));
    await firstVisit;

    // 落地会把这条会话整个重建一遍。放它进来,读者这一次访问读到的那一页就
    // 被上一次访问的答复顶掉了 —— 而那一页是上一次访问的,读者已经离开过。
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['srv-hello again']);
    // 那一轮不在这个 store 里,所以它连碰都碰不到 —— 请求照常跑着。
    expect(sent?.aborted).toBe(false);
  });

  it('does not take the next visit\'s request off the books when it lands', async () => {
    let landFirstVisit: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        landFirstVisit = resolve;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    // The second visit's request never answers, so it stays on the books for
    // as long as it is running -- which is what a second caller joins.
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));
    void conversationRuntime.ensureLoaded('p-1');

    landFirstVisit(answer(['hello again']));
    await firstVisit;

    // The first visit's request is over and takes itself off the books. Taking
    // the entry off by name takes off whatever is there, which by now is the
    // second visit's -- and the next caller, finding nothing, asks the server
    // all over again for something already on its way. Not awaited: joining
    // the request still running is the whole point, and it does not answer.
    void conversationRuntime.ensureLoaded('p-1');
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
  });

  it('does not turn a chat that is open and being read into one that failed', async () => {
    let refuseFirstVisit: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuseFirstVisit = reject;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    vi.mocked(chatApi.openChat).mockResolvedValueOnce(answer(['readable history']));
    await conversationRuntime.ensureLoaded('p-1');

    refuseFirstVisit(new Error('timed out'));
    await firstVisit;

    // Otherwise the conversation on screen is replaced by an empty column
    // saying the chat could not be opened -- about a request made for a
    // screen the reader already left.
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');
  });

  it('does not leave a hole in the middle of the message column', async () => {
    vi.mocked(chatApi.openChat).mockResolvedValue(answer(['newest'], true));
    await conversationRuntime.ensureLoaded('p-1');

    let landPage: (p: Awaited<ReturnType<typeof chatApi.messagesBefore>>) => void = () => {};
    vi.mocked(chatApi.messagesBefore).mockReturnValueOnce(
      new Promise((resolve) => {
        landPage = resolve;
      }),
    );
    const earlier = conversationRuntime.loadEarlier('c-1');

    conversationRuntime.leaveProject('p-1');
    await conversationRuntime.ensureLoaded('p-1');

    landPage({
      messages: [
        {
          id: 'old',
          role: 'user',
          parts: [{ type: 'text', text: 'turn ten' }],
          metadata: { turnIndex: 10, ts: '2026-08-01T00:00:00Z' },
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await earlier;

    // The page was asked for from where the previous visit had read back to.
    // Written onto the newest page the new visit adopted, it puts turn 10
    // directly above turn 40 with nothing on screen saying what is missing --
    // and moves the cursor past the gap, so no press can ever ask for it.
    expect(conversation()?.messages.map((m) => m.id)).toEqual(['srv-newest']);
    expect(conversation()?.oldestLoadedTurn).toBe(40);
  });
});

describe('opening again after it failed', () => {
  it('asks again, which is what the retry button does', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');
    expect(conversation()?.messages).toHaveLength(1);
  });
});

describe('telling the reader that something went wrong', () => {
  /**
   * Collect every mishap told while the given work runs.
   * @param work - Run with a watcher attached.
   * @returns What it was told, in order.
   */
  async function whatIsTold(work: () => Promise<void> | void): Promise<ChatMishap[]> {
    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await work();
    stop();
    return told;
  }

  it('calls a page it could not reach back for a network error too', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockRejectedValueOnce(new Error('blip'));

    const told = await whatIsTold(() => conversationRuntime.loadEarlier('c-1'));

    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' })]);
    // Still offering, because the reader may simply press it again.
    expect(conversation()?.hasMore).toBe(true);
  });
});
