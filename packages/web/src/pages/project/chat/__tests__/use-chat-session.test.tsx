// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 面板从这一个地方读它要画的东西。
 *
 * 历史和正在流下来的那条回复是同一个列表 —— 分开放（历史在一处、流式回复在
 * 另一个变量里）正是「一条回复出现两次」「流一结束就消失」「刷新之后顺序不
 * 对」的来源。迁移之后这个列表由 `Chat` 实例持有，而这个 hook 把它翻译成面板
 * 画得出来的形状：正文和思考各自跨 part 拼起来、工具调用成一张列表、中断和
 * 失败两个记号读出来。
 *
 * 一轮对话本身怎么跑（发出去的请求体、三种状态、心跳判死、出错说哪一句）在
 * `turn-states.test.tsx` 和 `stores/__tests__/` 那三个文件里；这里只测这层
 * 翻译，以及它跟面板生命周期之间那些事。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
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
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { _resetForTests } from '@web/stores/conversation-runtime';
import { tell } from '@web/stores/chat-mishaps';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { stubChatWire, turnOpens } from '@web/test-utils/chat-wire';
import type { WatchedWire } from '@web/test-utils/chat-wire';

/** 这一轮的流。 */
let wire: WatchedWire;

/**
 * 打开会话时服务端说这条会话里有什么。
 * @param messages - 已经说过的话。
 * @param conversationId - 哪一条会话。
 */
function openChatAnswers(
  messages: Array<{ id: string; role: string; text: string }>,
  conversationId = 'c-1',
): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: conversationId }],
    current: {
      conversation: { id: conversationId },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: 'text', text: m.text }],
        metadata: { turnIndex: 1, ts: '2026-08-11T00:00:00Z' },
      })),
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * 渲染这个 hook。
 * @param listOpen - 会话列表在不在屏幕上。
 * @returns renderHook 的结果。
 */
function render(
  listOpen = false,
): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  return renderHook(() => useChatSession('p-1', listOpen));
}

/**
 * 渲染面板并等它把会话读回来。
 * @returns renderHook 的结果。
 */
async function anOpenPanel(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>>
  > {
  const panel = render();
  await waitFor(() => {
    expect(panel.result.current.status).toBe('ready');
  });
  return panel;
}

/**
 * 发一句话出去，并等这一轮真的开始流。
 * @param panel - 那个面板。
 * @param said - 说了什么。
 */
async function aReplyStartsArriving(
  panel: ReturnType<typeof render>,
  said = '找几张参考图',
): Promise<void> {
  act(() => {
    void panel.result.current.send(said);
  });
  await waitFor(() => {
    expect(wire.current()).not.toBeNull();
  });
  act(() => {
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
  });
  await waitFor(() => {
    expect(panel.result.current.turnPhase).toBe('running');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 模块单例活得比这个文件里每一个用例都长，跟它活得比面板长是同一件事。
  _resetForTests();
  evictAllChatSessions();
  wire = stubChatWire();
  openChatAnswers([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 放这儿而不是放用例末尾:一条用例在假时钟下超时就永远走不到那一行,
  // 之后每一条都在假时钟上跑,而 `waitFor` 靠真定时器轮询 —— 一条挂掉会
  // 变成整个文件挂掉。
  vi.useRealTimers();
});

describe('what the panel shows when it opens', () => {
  it('asks the server once and shows what it says', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: '之前问过的' },
      { id: 'm2', role: 'assistant', text: '之前答过的' },
    ]);

    const panel = await anOpenPanel();

    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(panel.result.current.messages.map((m) => m.content)).toEqual([
      '之前问过的',
      '之前答过的',
    ]);
  });

  it('shows nothing until the server has answered', () => {
    vi.mocked(chatApi.openChat).mockReturnValue(new Promise(() => {}));

    const panel = render();

    expect(panel.result.current.status).toBe('loading');
    expect(panel.result.current.messages).toEqual([]);
  });

  it('asks the server nothing when the conversation is already loaded', async () => {
    openChatAnswers([{ id: 'm1', role: 'user', text: '之前问过的' }]);
    const first = await anOpenPanel();
    first.unmount();

    const second = await anOpenPanel();

    // 再问一次能学到的只有「服务端还不知道的那半」—— 而那半正是屏幕上唯一
    // 会被顶掉的东西。
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(second.result.current.messages.map((m) => m.content)).toEqual(['之前问过的']);
  });
});

describe('a reply as the panel draws it', () => {
  it('grows in one place as the pieces arrive', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    for (const delta of ['好的', '，我', '来找']) {
      act(() => {
        wire.current()?.push({ type: 'text-delta', id: 't1', delta });
      });
    }

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('好的，我来找');
    });
    // 一条，不是三条。每一片各成一条气泡就是同一个回答被拆成一串。
    expect(panel.result.current.messages).toHaveLength(2);
  });

  it('is marked as being written, so the bubble can say so', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.streaming).toBe(true);
    });
  });

  it('stops being marked when the turn is over', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });

    act(() => {
      wire.current()?.push({ type: 'text-end', id: 't1' });
      wire.current()?.push({ type: 'finish-step' });
      wire.current()?.push({ type: 'finish' });
      wire.current()?.close();
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('idle');
    });
    expect(panel.result.current.messages.at(-1)?.streaming).toBeUndefined();
  });

  it('collects the thinking onto the reply it belongs to', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    act(() => {
      wire.current()?.push({ type: 'reasoning-start', id: 'r1' });
      wire.current()?.push({ type: 'reasoning-delta', id: 'r1', delta: '先想想' });
      wire.current()?.push({ type: 'reasoning-delta', id: 'r1', delta: '要什么风格' });
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.thinking).toBe('先想想要什么风格');
    });
    // 思考和正文是两样东西,面板分开画。混进正文里读者会看到模型的草稿。
    expect(panel.result.current.messages.at(-1)?.content).toBe('好的');
  });

  it('hands back the same object for every message that did not change', async () => {
    openChatAnswers([{ id: 'm1', role: 'user', text: '之前问过的' }]);
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('好');
    });
    const settledBefore = panel.result.current.messages[0];

    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '的' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('好的');
    });

    // 每一片都重建整份列表,就是把每一条气泡都交给 React 当新的 —— 一秒钟
    // 几十次,整列都在重画。
    expect(panel.result.current.messages[0]).toBe(settledBefore);
  });
});

describe('a turn that failed', () => {
  it('is marked on the reply, and marked as happening now', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages).toHaveLength(2);
    });

    act(() => {
      wire.current()?.push({ type: 'error', errorText: 'The assistant could not finish this turn.' });
      wire.current()?.close();
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.failed).toBe(true);
    });
    // 正在经历的失败要读出来;而历史里那些失败过的轮次不能 —— 面板一打开
    // 会把它们全部念一遍。
    expect(panel.result.current.messages.at(-1)?.failedJustNow).toBe(true);
  });

  it('is read back out of the history without being announced again', async () => {
    openChatAnswers([{ id: 'm1', role: 'assistant', text: '' }]);
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1' }],
      current: {
        conversation: { id: 'c-1' },
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'text', text: '半句' }, { type: 'data-failed', data: null }],
            metadata: { turnIndex: 1, ts: '2026-08-11T00:00:00Z' },
          },
        ],
        hasMore: false,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    const panel = await anOpenPanel();

    expect(panel.result.current.messages.at(-1)?.failed).toBe(true);
    expect(panel.result.current.messages.at(-1)?.failedJustNow).toBeUndefined();
  });
});

describe('a turn the reader stopped', () => {
  it('marks the reply the way the server records it', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '半句' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages).toHaveLength(2);
    });

    act(() => {
      panel.result.current.abort();
    });

    // 不留记号,同一条消息现在读起来是「答完了」、刷新之后才变成「被中断」。
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.interrupted).toBe(true);
    });
    expect(panel.result.current.turnPhase).toBe('idle');
  });
});

describe('what the panel says went wrong', () => {
  it('announces it, and forgets it on its own', async () => {
    const panel = await anOpenPanel();
    // 面板到位之后才换假时钟:`waitFor` 靠真定时器轮询。
    vi.useFakeTimers();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' });
    });
    expect(panel.result.current.mishap).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    // 出错不是聊天所处的一个状态,是一件在某个时刻发生过的事 —— 它自己会走。
    expect(panel.result.current.mishap).toBeNull();
  });

  it('says nothing about another conversation streaming in the background', async () => {
    const panel = await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-other', kind: 'network' });
    });

    expect(panel.result.current.mishap).toBeNull();
  });

  it('says it anyway when the reader did it on purpose', async () => {
    const panel = await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-other', deliberate: true, kind: 'network' });
    });

    // 改名和删除是读者按下去、等着听回话的事,而它们通常说的正是别的会话。
    expect(panel.result.current.mishap).not.toBeNull();
  });

  it('gives a word about a row to the list, while the list is on screen', async () => {
    const panel = render(true);
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-2', deliberate: true, aboutRow: true, kind: 'network' });
    });

    // 列表开着的时候盖住整列,面板自己那条线在输入框上边 —— 画在那儿没人读得到。
    expect(panel.result.current.rowMishap).not.toBeNull();
    expect(panel.result.current.mishap).toBeNull();
  });

  it('keeps it in the panel when the list is shut', async () => {
    const panel = await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-2', deliberate: true, aboutRow: true, kind: 'network' });
    });

    // 会话头也能改名,那时候抽屉是关着的。
    expect(panel.result.current.mishap).not.toBeNull();
    expect(panel.result.current.rowMishap).toBeNull();
  });

  it('is not held for a reader who was not looking', async () => {
    const panel = await anOpenPanel();
    panel.unmount();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' });
    });
    const back = await anOpenPanel();

    // 回来看到的是一条不再动的会话,那就是他知道出事的方式;没有任何地方
    // 替他存着这条消息。
    expect(back.result.current.mishap).toBeNull();
  });
});

describe('when the panel goes away mid-stream', () => {
  it('leaves the turn running, because collapsing the column is not leaving', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    panel.unmount();

    expect(wire.signal()?.aborted).toBe(false);
  });

  it('shows the same reply, still being written, when the column is opened again', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.current()?.push({ type: 'text-delta', id: 't1', delta: '写到一半' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('写到一半');
    });
    panel.unmount();

    const back = await anOpenPanel();

    expect(back.result.current.messages.at(-1)?.content).toBe('写到一半');
    expect(back.result.current.turnPhase).toBe('running');
  });
});

describe('when the chat never opened', () => {
  it('looks like an empty conversation, because that is what is on screen', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));

    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('failed');
    });

    expect(panel.result.current.messages).toEqual([]);
    expect(panel.result.current.currentId).toBeUndefined();
  });

  it('starts a conversation when the reader sends anyway', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('failed');
    });
    openChatAnswers([]);

    act(() => {
      void panel.result.current.send('还是想问');
    });

    await waitFor(() => {
      expect(wire.sent()).toHaveLength(1);
    });
    expect(wire.sent()[0]).toMatchObject({ conversation_id: 'c-1', message: '还是想问' });
  });
});
