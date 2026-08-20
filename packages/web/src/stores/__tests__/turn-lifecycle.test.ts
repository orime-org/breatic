// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 一轮从按下发送到结束，中间那几样事实各自归谁写。
 *
 * 设计定稿 §7.3 那张转移表钉在这里。表是实现对抗第一轮之后补的：那一轮咬出的
 * 十条承诺内问题里有五条同源 —— 「这一轮处在什么状态」没有唯一持有者，五条路
 * 径能改它、两个事件能换掉观察者，于是每条路径各自决定改哪些事实。
 *
 * 这个文件只管三格，都是那五条各自的出口：
 *
 * 第一格是 `submitted` 碰上服务端拒绝。SDK 在按下那一刻就把用户消息 push 进
 * 去了，而它不回滚；渲染侧只在 `submitted` 期间把它挡住，一到 `error` 就画出
 * 来 —— 那时输入框里还是同一句话（第一帧从没到过，从来没清过），用户再按一次
 * 就发了两遍。心跳判死那条路一直在收，这条路没有。
 *
 * 第二格是第一个 chunk 到达时清空输入框。它此前挂在面板的 effect 上，于是面板
 * 不在场的那一轮永远不清（折叠 Agent 列、或者切到另一条会话，都是被鼓励的操
 * 作），而面板重新挂上来时又会再清一次、把用户新打的字抹掉。
 *
 * 第三格是看门狗装表的时机。装表要先问服务端心跳间隔是多少，而那本身是一次
 * 请求；等它回来的时候这一轮可能已经结束了。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

const BEAT_MS = 5000;

/** 这一轮问心跳间隔时，答复挂在这里，由用例决定什么时候回。 */
let answerConfig: ((value: { heartbeatIntervalMs: number }) => void) | null = null;

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(
      () =>
        new Promise<{ heartbeatIntervalMs: number }>((resolve) => {
          answerConfig = resolve;
        }),
    ),
  },
}));

import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions, sendInSession } from '@web/stores/chat-sessions';
import {
  OPENING_BEAT,
  stubChatWire,
  stubRefusingWire,
  turnOpens,
} from '@web/test-utils/chat-wire';

/** 说出来的每一条。 */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;
/** 第一帧到达时收到的通知，一轮该恰好一次。 */
let firstFrames = 0;

/**
 * 起一条会话。
 * @returns 它的 `Chat` 实例。
 */
function aConversation(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => {
      firstFrames += 1;
    },
  });
}

/** 让排着的微任务都跑完，不动假时钟。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  told = [];
  firstFrames = 0;
  answerConfig = null;
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
});

afterEach(() => {
  stopWatching?.();
  evictAllChatSessions();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('第一帧之前被服务端拒掉', () => {
  it('把那条已经推进去的用户消息收回来', async () => {
    stubRefusingWire(402, '积分不足');
    const chat = aConversation();
    await sendInSession('c-1', '帮我找参考图');
    await settle();

    expect(chat.status).toBe('error');
    expect(chat.messages).toHaveLength(0);
  });

  it('输入框那一格没被碰过，字还在读者自己那儿', async () => {
    stubRefusingWire(402, '积分不足');
    aConversation();
    await sendInSession('c-1', '帮我找参考图');
    await settle();

    expect(firstFrames).toBe(0);
  });

  it('转达服务端自己写的那句话', async () => {
    stubRefusingWire(402, '积分不足');
    aConversation();
    await sendInSession('c-1', '帮我找参考图');
    await settle();

    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'server', message: '积分不足' });
  });
});

describe('第一帧到达', () => {
  it('心跳不算，它到的时候这一轮还什么都没说', async () => {
    // 服务端每条流的第一帧都是心跳（`routes/chat.ts:141`，socket 一有就写一
    // 次）。它是 transient，SDK 交给 `onData` 就丢掉、不进 `write()`，所以
    // status 还停在 submitted、那条用户消息还被渲染侧挡着。这时候清空输入框，
    // 那句话就两处都不在了。
    const wire = stubChatWire();
    aConversation();
    void sendInSession('c-1', '帮我找参考图');
    await settle();

    wire.current()?.push(OPENING_BEAT);
    wire.current()?.push(OPENING_BEAT);
    await settle();
    expect(firstFrames).toBe(0);

    // 真正开口的那一帧到了才算。
    wire.current()?.push({ type: 'start' });
    await settle();
    expect(firstFrames).toBe(1);
  });

  it('说一次，不管这会儿有没有面板在看', async () => {
    const wire = stubChatWire();
    aConversation();
    void sendInSession('c-1', '帮我找参考图');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    await settle();

    expect(firstFrames).toBe(1);
  });

  it('后面再来多少帧也只说那一次', async () => {
    const wire = stubChatWire();
    aConversation();
    void sendInSession('c-1', '帮我找参考图');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    wire.current()?.push({ type: 'text-delta', id: 't1', delta: '好' });
    wire.current()?.push({ type: 'text-delta', id: 't1', delta: '的' });
    await settle();

    expect(firstFrames).toBe(1);
  });
});

describe('答复已经开始之后才失败', () => {
  it('不把那条用户消息收回来，服务端已经把它记下了', async () => {
    // 服务端存这句话是这一轮做的第一件事（`main-agent.ts` 的 `addMessage`），
    // 而它在任何带内容的帧之前。所以只要开口的那一帧到过，库里就有这句话 ——
    // 这时候把它从列表里拿掉，屏幕就跟刷新之后读到的对不上了。
    const wire = stubChatWire();
    const chat = aConversation();
    void sendInSession('c-1', '帮我找参考图');
    await settle();

    wire.current()?.push(OPENING_BEAT);
    wire.current()?.push({ type: 'start' });
    await settle();

    // 组装历史或调模型那一步失败，路由写一个 error 帧（`routes/chat.ts`）。
    wire.current()?.push({ type: 'error', errorText: 'The turn could not be run.' });
    wire.current()?.close();
    await settle();

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.role).toBe('user');
  });
});

describe('问心跳间隔的那次往返，比这一轮还长', () => {
  it('答复回来时这一轮已经结束了，就不再装表', async () => {
    stubRefusingWire(404, '这条会话已经不在了');
    const chat = aConversation();
    await sendInSession('c-1', '帮我找参考图');
    await settle();

    // 这一轮已经以失败结束，读者已经被告知过一次。
    expect(chat.status).toBe('error');
    expect(told).toHaveLength(1);

    // 心跳间隔这时候才答复回来。
    answerConfig?.({ heartbeatIntervalMs: BEAT_MS });
    await settle();
    await vi.advanceTimersByTimeAsync(BEAT_MS * 4);
    await settle();

    // 没有第二条，也没有人在一条空闲会话上盖记号。
    expect(told).toHaveLength(1);
    expect(chat.messages).toHaveLength(0);
  });
});
