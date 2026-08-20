// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一轮没能跑完的时候，读者听到的是哪一句。
 *
 * 四句话对四种情况，而分辨它们的依据全在「回来的是什么」：服务器写了一句给
 * 读者的话（积分不够、太频繁、没权限）· 有东西答了但里面没有我们的东西（网关
 * 超时那种，只能由这一端说「这条回复不来了，再发一次」）· 什么都没答（离线）·
 * 以及读者自己按的停止，那个不该说任何话。
 *
 * 这几条原来钉在 store 的事件 switch 上；轮次搬进会话实例之后，出错也是在
 * 那儿学到的，所以测试跟着搬。判据换了：以前看的是自写传输层抛的三种异常，
 * 现在看的是 SDK 抛出来的那一个 `Error`，以及它是不是 `TypeError`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: { streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000 })) },
}));

import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import {
  chatSessionFor,
  evictAllChatSessions,
  sendInSession,
  stopChatSession,
} from '@web/stores/chat-sessions';

/** 说出来的每一条。 */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;

/**
 * 让这一轮的请求以某种方式结束。
 * @param answer - fetch 该怎么答，或者抛什么。
 */
function theServerAnswers(answer: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(answer));
}

/**
 * 起一条会话并发一句话，等到这一轮结束。
 * @returns 那条会话的 `Chat` 实例。
 */
async function aTurnRunsAndEnds(): Promise<ReturnType<typeof chatSessionFor>> {
  const chat = chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
  });
  await sendInSession('c-1', '找几张参考图');
  return chat;
}

beforeEach(() => {
  evictAllChatSessions();
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
});

afterEach(() => {
  stopWatching?.();
  vi.unstubAllGlobals();
});

describe('一轮没能跑完', () => {
  it('服务器写了话就原样转达，那是用他自己的语言写的', async () => {
    // 信封就是 `middleware/error-handler.ts` 写出来的那个形状。这条用例原先
    // 造的是 `{ error: "..." }`，服务端从来不答那个形状 —— 于是读它的那一支
    // 从写下那天起就没被走到过，而线上每一次被拒的轮次都读不出服务端的话。
    theServerAnswers(
      async () =>
        new Response('{"error":{"code":402,"message":"You are out of credits."}}', {
          status: 402,
        }),
    );

    await aTurnRunsAndEnds();

    expect(told).toEqual([
      expect.objectContaining({
        projectId: 'p-1',
        conversationId: 'c-1',
        kind: 'server',
        message: 'You are out of credits.',
      }),
    ]);
  });

  it('有东西答了但里面没有我们的东西，就只说这条回复不来了', async () => {
    // 网关超时长这样：它确实答了，所以网络没问题；但那段话是写给开发者看的
    // 英文，从来没过 `t()`。
    theServerAnswers(async () => new Response('<html>504 Gateway Timeout</html>', { status: 504 }));

    await aTurnRunsAndEnds();

    expect(told.map((m) => m.kind)).toEqual(['turn']);
  });

  it('什么都没答就是网络的事', async () => {
    // 离线时 fetch 按规范抛 TypeError，这是「根本没连上」跟「答了一句我们读
    // 不懂的」之间唯一的区别。
    theServerAnswers(() => Promise.reject(new TypeError('Failed to fetch')));

    await aTurnRunsAndEnds();

    expect(told.map((m) => m.kind)).toEqual(['network']);
  });

  it('读者自己按的停止，一个字都不说', async () => {
    theServerAnswers(
      async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    const chat = chatSessionFor({
      projectId: 'p-1',
      conversationId: 'c-1',
      history: [],
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });
    const running = sendInSession('c-1', '找几张参考图');
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });

    stopChatSession('c-1');
    await running;

    // 他刚做完这件事，不用再告诉他一遍。
    expect(told).toEqual([]);
    // 这一轮一个字都没答上来（流开着但什么都没推），所以那条用户消息被收回 ——
    // 跟心跳判死那条路一样，也跟输入框里还留着同一句话这件事对得上（第一帧没
    // 到过，从来没清过）。定稿 §7.3.3。
    expect(chat.messages).toHaveLength(0);
  });

  it('没人在看的时候说了也是白说，不留着以后讲', async () => {
    stopWatching?.();
    stopWatching = undefined;
    theServerAnswers(async () => new Response('<html>504</html>', { status: 504 }));

    await aTurnRunsAndEnds();

    // 现在挂上去，就是读者回来了——他什么都听不到。他看到的是一条不再动的
    // 会话，那就是他知道出事的方式；没有任何地方替他存着这条消息。
    const late: ChatMishap[] = [];
    const stop = watchChatMishaps((mishap) => late.push(mishap));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(late).toEqual([]);
  });
});
