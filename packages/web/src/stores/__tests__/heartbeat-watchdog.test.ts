// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一条不再说话的流，多久之后算死。
 *
 * 连接死掉而没有关闭时，socket 不报错、也不 close —— 它只是再也不说话了。
 * 没有这块，那一轮会一直等一个永远不来的回复，而在它等着的整段时间里输入框
 * 是锁住的，用户什么都发不出去。
 *
 * 预算从按下发送那一刻起算，只有这一个：连接建立本身也花在这个预算里，因为
 * 「请求根本没连上」正是别的东西都报不出来的那一种。
 *
 * 判死之后要把 SDK 已经 push 进去的那条用户消息收回来（B5）：`status` 回到
 * `ready` 之后渲染侧不再排除它，那条气泡会当场出现，而输入框里的字还在（第一
 * 帧没到过，从来没清过），同一句话就同时在两处，用户重发一次就是两条。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSE_HEARTBEAT_MISSES_ALLOWED } from '@breatic/shared';
import type * as ChatApiModule from '@web/data/api/chat';

const BEAT_MS = 5000;

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: BEAT_MS })),
  },
}));

import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions, sendInSession } from '@web/stores/chat-sessions';

/** 这一轮的流，测试自己往里推东西。 */
let wire: {
  push: (chunk: Record<string, unknown>) => void;
} | null = null;

/** 这一轮请求拿到的中止信号。 */
let sent: AbortSignal | null | undefined;

/** 说出来的每一条。 */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;

/**
 * 起一条会话并发一句话出去。
 * @returns 这条会话的 `Chat` 实例。
 */
async function aTurnGoesOut(): ReturnType<typeof chatSessionFor> extends infer T
  ? Promise<T>
  : never {
  const chat = chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
  });
  void sendInSession('c-1', '找几张参考图');
  // 冲刷微任务，不用 `vi.waitFor`：假时钟下它会自己往前拨，而这一轮的预算正是
  // 从按下发送起算的，被它拨掉多少就少等多少。
  for (let tick = 0; tick < 20 && wire === null; tick++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  return chat;
}

beforeEach(() => {
  vi.useFakeTimers();
  evictAllChatSessions();
  wire = null;
  sent = undefined;
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent = init?.signal;
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
      };
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }),
  );
});

afterEach(() => {
  stopWatching?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('一条不再说话的流', () => {
  it('连着三次没心跳就判死，并且说一声', async () => {
    await aTurnGoesOut();

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);

    expect(sent?.aborted).toBe(true);
    expect(told.map((m) => m.kind)).toContain('network');
  });

  it('两次没收到还不算，第三次才算', async () => {
    await aTurnGoesOut();

    await vi.advanceTimersByTimeAsync(BEAT_MS * (SSE_HEARTBEAT_MISSES_ALLOWED - 1));

    expect(sent?.aborted).toBe(false);
  });

  it('心跳一到就重新开始数', async () => {
    await aTurnGoesOut();

    // 差一点点到线的时候来一下，然后再等同样久。没有重新计时的话这里已经死了。
    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED - 100);
    wire?.push({ type: 'data-heartbeat', transient: true, data: {} });
    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED - 100);

    expect(sent?.aborted).toBe(false);
  });

  it('把那条已经推进去的用户消息收回来', async () => {
    const chat = await aTurnGoesOut();
    expect(chat.messages.map((m) => m.role)).toEqual(['user']);

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);

    // 留着它，那条气泡在 status 回到 ready 之后当场出现，而输入框里的字还在。
    expect(chat.messages).toHaveLength(0);
  });

  it('第一帧已经到了就不收回，那条回复是真的', async () => {
    const chat = await aTurnGoesOut();
    wire?.push({ type: 'start' });
    wire?.push({ type: 'start-step' });
    wire?.push({ type: 'text-start', id: 't1' });
    wire?.push({ type: 'text-delta', id: 't1', delta: '好的' });
    for (let tick = 0; tick < 20 && chat.messages.length < 2; tick++) {
      await vi.advanceTimersByTimeAsync(0);
    }

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);

    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
