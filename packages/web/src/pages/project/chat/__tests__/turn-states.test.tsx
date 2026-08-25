// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 一轮对话的三种状态，以及它们各自在屏幕上是什么样。
 *
 * 传输和状态都由 `useChat` 管：面板订阅一个 `Chat` 实例，那个实例把消息
 * 发出去、把回来的东西攒起来。这个文件从 `fetch` 那一层往上全是真的——真的
 * transport 解析流、真的 `Chat` 状态机、真的 hook 订阅——只有网络本身是替身。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(),
    listConversations: vi.fn(),
    earlierMessages: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';

/** 这一轮的流，测试自己往里推东西。 */
let wire: {
  push: (chunk: Record<string, unknown>) => void;
  close: () => void;
} | null = null;

/** 每次发送时收到的请求体，按顺序。 */
let sentBodies: Array<Record<string, unknown>> = [];

/**
 * 让下一次请求拿到一条测试握着的流。
 * @returns 那条流的响应。
 */
function openWire(): Response {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  wire = {
    push: (chunk) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    close: () => {
      controller.close();
    },
  };
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * 打开会话时服务器说这条会话里有什么。
 * @param messages - 已经说过的话，协议的形状。
 */
function openChatAnswers(messages: Array<Record<string, unknown>>): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c-1' }],
    current: {
      conversation: { id: 'c-1' },
      messages,
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * 渲染面板要的那份东西。
 * @returns renderHook 的结果。
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  return renderHook(() => useChatSession('p-1'));
}

beforeEach(() => {
  vi.clearAllMocks();
  wire = null;
  sentBodies = [];
  _resetForTests();
  evictAllChatSessions();
  openChatAnswers([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return openWire();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('发一条消息', () => {
  it('走的是聊天端点，带上服务器要的那四个字段', async () => {
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });

    // Not awaited: sending settles when the turn is over, and this one is
    // held open on purpose -- what is being read is the request that went out.
    act(() => {
      void panel.result.current.send('找几张参考图');
    });
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    const [url] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain('/chat/message');
    // 整份比对，不是包含：多一个字段服务器会一声不响地丢掉，少一个是 422，
    // 而用户看到的都是「发失败了，不知道为什么」。
    expect(sentBodies[0]).toEqual({
      message: '找几张参考图',
      project_id: 'p-1',
      conversation_id: 'c-1',
      attached_chips: [],
    });
  });

  it('第一帧没到之前，列表里不多一条气泡', async () => {
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });

    act(() => {
      void panel.result.current.send('找几张参考图');
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('sending');
    });
    // 库是先把用户消息推进列表、再把状态置成「已发出」的，所以这一条要靠
    // 渲染侧按状态排除。屏幕上这时候应该什么都没多。
    expect(panel.result.current.messages).toHaveLength(0);
  });

  it('第一帧到了，用户那句话和回复一起出现', async () => {
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });

    act(() => {
      void panel.result.current.send('找几张参考图');
    });
    await waitFor(() => {
      expect(wire).not.toBeNull();
    });

    act(() => {
      wire?.push({ type: 'start' });
      wire?.push({ type: 'start-step' });
      wire?.push({ type: 'text-start', id: 't1' });
      wire?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('running');
    });
    // 消息走 useChat 自己的 throttle，跟 turnPhase 不是同一次更新，所以等它到。
    await waitFor(() => {
      expect(panel.result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(panel.result.current.messages[0]?.content).toBe('找几张参考图');
      expect(panel.result.current.messages[1]?.content).toBe('好的');
    });
  });
});

describe('输入框里的字', () => {
  it('第一帧到了才清空，不是按下发送就清', async () => {
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });
    act(() => {
      conversationRuntime.setDraft('c-1', '找几张参考图');
    });

    act(() => {
      void panel.result.current.send('找几张参考图');
    });
    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('sending');
    });
    // 服务端还没答话。这时候清掉，一旦这一轮被拒，用户的字就没了、也没有
    // 任何东西能把它放回去。
    expect(panel.result.current.draft).toBe('找几张参考图');

    act(() => {
      wire?.push({ type: 'start' });
      wire?.push({ type: 'start-step' });
      wire?.push({ type: 'text-start', id: 't1' });
      wire?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });

    await waitFor(() => {
      expect(panel.result.current.draft).toBe('');
    });
  });

  it('只清这一条会话的，别人那条不动', async () => {
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });
    act(() => {
      conversationRuntime.setDraft('c-2', '另一条里没发出去的半句话');
    });

    act(() => {
      void panel.result.current.send('找几张参考图');
    });
    await waitFor(() => {
      expect(wire).not.toBeNull();
    });
    act(() => {
      wire?.push({ type: 'start' });
      wire?.push({ type: 'start-step' });
      wire?.push({ type: 'text-start', id: 't1' });
      wire?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    });
    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('running');
    });

    expect(conversationRuntime.draftOf('c-2')).toBe('另一条里没发出去的半句话');
  });
});

describe('发不出去的时候', () => {
  it('告诉用户一声，不悄悄新开一条会话把话放进去', async () => {
    // 会话在服务器上没了——另一个标签页或另一个人删掉的——服务器答 404。
    // 这时候不重开：重开等于把这句话放进一条凭空出现的新会话，而屏幕上
    // 原来那条的历史还在，用户会看到自己的话跑到了别处（user 2026-08-19
    // 拍定）。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"Conversation not found"}', { status: 404 })),
    );

    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });

    await act(async () => {
      await panel.result.current.send('找几张参考图');
    });

    await waitFor(() => {
      expect(panel.result.current.mishap).not.toBeNull();
    });
    // 一次请求，不是两次：第二次就是那个「重开一条再发一遍」。
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatApi.openChat)).toHaveBeenCalledTimes(1);
  });
});
