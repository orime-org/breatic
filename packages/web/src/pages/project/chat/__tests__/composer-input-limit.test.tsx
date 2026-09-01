// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 输入框的上限，和它说出来的那一行（#148, G1）。
 *
 * 上限本身交给浏览器：`maxLength` 让第 10,001 个字符打不进去，粘贴超长文本
 * 时自动截到上限。这条路上没有我们的代码，所以这里断言的是那个属性真的挂着。
 *
 * 那一行提示是我们的：到了上限才出现，删掉一个字就消失。没有它，输入框会在
 * 用户还在打字时静静地不再接受任何东西。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// 上限换成一个跟五份文案里都不一样、且带千分位的数。文案自己写死 10,000 时，
// 「说出来的数就是生效的数」那条永远成立，看不出它根本没读这个常量；而 12,345
// 这个形状还顺带钉住了 ICU 的数字格式化——占位换成裸的 {limit} 就少了逗号。
vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, CHAT_MESSAGE_MAX_CHARS: 12345 };
});

const { CHAT_MESSAGE_MAX_CHARS } = await import('@breatic/shared');
const { ChatComposer } = await import('@web/pages/project/chat/ChatComposer');

/**
 * 渲染一个输入框，草稿内容由用例给。
 * @param draft - 输入框里现在有什么。
 */
function setup(draft: string): void {
  render(
    <ChatComposer draft={draft} onChange={vi.fn()} onSubmit={vi.fn()} onAbort={vi.fn()} />,
  );
}

describe('输入框的上限', () => {
  it('把上限交给浏览器，粘贴超长文本时由它截断', () => {
    setup('');

    expect(screen.getByTestId('chat-composer-textarea')).toHaveAttribute(
      'maxlength',
      String(CHAT_MESSAGE_MAX_CHARS),
    );
  });

  it('到了上限才说，说的是已经到了', () => {
    setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS));

    expect(screen.getByTestId('chat-composer-limit')).toBeInTheDocument();
  });

  it('说出来的那个数就是真正生效的那个', () => {
    setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS));

    expect(screen.getByTestId('chat-composer-limit')).toHaveTextContent(
      '12,345',
    );
  });

  it('差一个字符时不说话', () => {
    // 提示提前出现比不出现更糟：它会让人以为打不进去了，而其实还能打。
    setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS - 1));

    expect(screen.queryByTestId('chat-composer-limit')).not.toBeInTheDocument();
  });

  it('空着的时候不说话', () => {
    setup('');

    expect(screen.queryByTestId('chat-composer-limit')).not.toBeInTheDocument();
  });
});
