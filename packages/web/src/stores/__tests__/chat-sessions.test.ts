// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 一条会话的状态活得比看着它的那个面板长。
 *
 * 折叠 agent 列、切到别的会话再切回来、组件重新挂载——这些都不该把正在跑的
 * 那一轮弄没。做法是 `Chat` 实例按会话 id 存在模块里，组件只订阅它，跟
 * `data/yjs/canvas-space.ts` 的 `getCanvasUndoManager` 同一个形状：按数据
 * 的 key 缓存，由明确的动作驱逐，不挂组件卸载。
 *
 * 这件事今天已经成立（`conversation-switching.test.ts:63` 钉着），迁移后
 * 「不得回退」，所以这里钉的是新做法下它仍然成立。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  chatSessionFor,
  evictChatSession,
  evictAllChatSessions,
  prependHistory,
} from '@web/stores/chat-sessions';
import type { StoredUiMessage } from '@web/data/api/chat';
import { setLocale } from '@breatic/shared';

/** 一条读回来的历史，够用就行。 */
const HISTORY: StoredUiMessage[] = [
  {
    id: 'row-1',
    role: 'user',
    parts: [{ type: 'text', text: '之前说过的话' }],
    metadata: { turnIndex: 1, ts: '2026-08-19T00:00:00Z' },
  },
];

describe('会话的 Chat 实例', () => {
  beforeEach(() => {
    evictAllChatSessions();
  });

  it('同一条会话拿到的是同一个', () => {
    const first = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: HISTORY, onTitled: () => undefined, onFirstFrame: () => undefined });
    const again = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: HISTORY, onTitled: () => undefined, onFirstFrame: () => undefined });

    expect(again).toBe(first);
  });

  it('两条会话各是各的', () => {
    const one = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });
    const other = chatSessionFor({ projectId: 'p-1', conversationId: 'c-2', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });

    expect(other).not.toBe(one);
  });

  it('第二次给的历史不动已有的那条会话', () => {
    // 这一条是 A4 的核心。一轮正在跑的时候，面板重新挂载会再读一次历史；
    // 拿它去覆盖，屏幕上正在长出来的那半句就没了。
    const chat = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });
    chat.messages = [
      {
        id: 'in-flight',
        role: 'assistant',
        parts: [{ type: 'text', text: '正在写' }],
        metadata: { turnIndex: 2, ts: '2026-08-19T00:00:02Z' },
      },
    ];

    const again = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: HISTORY, onTitled: () => undefined, onFirstFrame: () => undefined });

    expect(again.messages).toHaveLength(1);
    expect(again.messages[0]?.id).toBe('in-flight');
  });

  it('把更早的一页接在头上，正在写的那半不动', () => {
    // 「加载更早」读回来的那一页要出现在屏幕上,而屏幕读的是这个实例 ——
    // 只写进 store 的话,它给下一个新建的实例当起点,对已经存在的这个毫无
    // 作用,读者按了按钮什么都不会发生。
    const chat = chatSessionFor({
      projectId: 'p-1',
      conversationId: 'c-1',
      history: [],
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });
    chat.messages = [
      {
        id: 'in-flight',
        role: 'assistant',
        parts: [{ type: 'text', text: '正在写' }],
        metadata: { turnIndex: 2, ts: '2026-08-19T00:00:02Z' },
      },
    ];

    prependHistory('c-1', HISTORY);

    expect(chat.messages.map((m) => m.id)).toEqual(['row-1', 'in-flight']);
  });

  it('对一条没在这儿的会话什么都不做', () => {
    // 面板走开之后那一页才回来,或者这条会话已经被删了。
    expect(() => {
      prependHistory('c-gone', HISTORY);
    }).not.toThrow();
  });

  it('驱逐之后再拿是新的一个', () => {
    const before = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });
    evictChatSession('c-1');
    const after = chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: HISTORY, onTitled: () => undefined, onFirstFrame: () => undefined });

    expect(after).not.toBe(before);
    expect(after.messages).toHaveLength(1);
  });
});

describe('一条聊天请求带着界面语言', () => {
  beforeEach(() => {
    evictAllChatSessions();
  });

  it('带的是语言开关选的那个，不是浏览器的', async () => {
    // 这个头只管服务端自己写的、要显示给用户看的文字（今天是 `chat.ts:87`
    // 那句「这条消息太长了」）。模型的回复跟它无关：那段话用什么语言由模型
    // 从对话里判断，我们一个字都不译。
    const sent: Array<{ url: string; init?: RequestInit }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      sent.push({ url: String(url), init });
      return Promise.resolve(
        new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    }) as typeof globalThis.fetch;

    try {
      setLocale('ja');
      const chat = chatSessionFor({
        projectId: 'p-1',
        conversationId: 'c-1',
        history: [],
        onTitled: () => undefined,
        onFirstFrame: () => undefined,
      });
      await chat.sendMessage({ text: '帮我看看' });

      // Read without regard to case: header names are case-insensitive and the
      // SDK lowercases what it is given.
      const headers = (sent.at(-1)?.init?.headers ?? {}) as Record<string, string>;
      const asked = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === 'accept-language',
      );

      expect(asked?.[1]).toBe('ja');
    } finally {
      globalThis.fetch = original;
      setLocale('en');
    }
  });
});
