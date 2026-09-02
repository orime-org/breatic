// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 「正在整理这条会话的记忆…」那一行，从属性到屏幕（#148, N3）。
 *
 * 服务端在归纳开始前发一次事件，store 记下来，一路传到等待点旁边。事件到
 * store 那一段由 `turn-lifecycle.test.ts` 钉着；这里钉的是最后一段——拿到这
 * 个属性之后，屏幕上到底有没有那行字。
 *
 * 它只在还没出字的那一轮上有意义：归纳发生在回复开始之前，而这行字解释的
 * 正是那几秒的等待。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { resetLocales, setLocale, setLocaleMessages, t } from '@breatic/shared';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import { MessageList } from '@web/pages/project/chat/MessageList';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { LOCALE_CATALOGS, readPath } from '@web/test-utils/locale-catalogs';

/**
 * 一条 agent 回复，流没流由用例定。
 * @param streaming - 这一轮还在收字吗。
 * @returns 消息。
 */
function reply(streaming: boolean): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', streaming };
}

describe('归纳中的那一行', () => {
  it('这一轮停下来整理记忆时说出来', () => {
    render(<MessageBubble message={reply(true)} consolidating />);

    expect(screen.getByTestId('chat-message-consolidating')).toHaveTextContent(
      t('chat.message.consolidating'),
    );
  });

  it('没在整理就只有那个点', () => {
    render(<MessageBubble message={reply(true)} />);

    expect(screen.getByTestId('chat-waiting-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-message-consolidating')).not.toBeInTheDocument();
  });

  it('已经结束的那一轮上不说话', () => {
    // 等待点自己就不在了，这行字是它的附注。
    render(<MessageBubble message={reply(false)} consolidating />);

    expect(screen.queryByTestId('chat-message-consolidating')).not.toBeInTheDocument();
  });

  it('从列表这一层传下去也到得了屏幕', () => {
    // 面板把这个属性交给列表，列表再挑出还在流的那条气泡。中间这两跳一起
    // 改掉，只打气泡的那三条用例照样全绿。
    render(<MessageList messages={[reply(true)]} consolidating ready />);

    expect(screen.getByTestId('chat-message-consolidating')).toBeInTheDocument();
  });

  it('列表里已经说完的那些气泡不跟着说', () => {
    render(
      <MessageList
        messages={[{ id: 'done', role: 'assistant', content: '说完了' }, reply(true)]}
        consolidating
        ready
      />,
    );

    expect(screen.getAllByTestId('chat-message-consolidating')).toHaveLength(1);
  });
});

// 本次新加的四句界面文字。逐个语种真渲染一次：只查字符串在不在，占位符改
// 名照样过——而那种改动会让 IntlMessageFormat 把参数原样留在句子里，用户读到
// 的是一句夹着大括号的话。
const NEW_COPY = [
  ['chat.message.consolidating', {}],
  ['chat.composer.atLimit', { limit: 10_000 }],
  ['chat.message.truncated', {}],
  ['server.chat.message_too_long', { limit: 15_000, actual: 15_001 }],
] as const;

describe.each(NEW_COPY)('%s', (key, params) => {
  it.each(LOCALE_CATALOGS)('%s 渲染得出一句完整的话', (tag, catalog) => {
    setLocaleMessages(tag, catalog as Record<string, unknown>);
    setLocale(tag);

    const rendered = t(key, params);

    // 键名原样返回 = 这个语种没有这句话。
    expect(rendered, tag).not.toBe(key);
    expect(rendered.trim(), tag).not.toBe('');
    // 占位符还在 = 参数名对不上，用户读到的是带大括号的句子。
    expect(rendered, tag).not.toMatch(/[{}]/);
  });

  it('四个非英文语种都真的翻过，不是把英文抄过去', () => {
    const english = readPath(LOCALE_CATALOGS[0][1], key);
    for (const [tag, catalog] of LOCALE_CATALOGS.slice(1)) {
      expect(readPath(catalog, key), tag).not.toBe(english);
    }
  });
});

afterEach(() => {
  resetLocales();
});
