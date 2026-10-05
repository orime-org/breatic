// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 输入框的上限，和它说出来的那一行（#148, G1）。
 *
 * 上限本身交给浏览器：`maxLength` 让第 10,001 个字符打不进去，粘贴超长文本
 * 时自动截到上限。这条路上没有我们的代码，所以这里断言的是那个属性真的挂着。
 *
 * 那一行提示是我们的，而且是一件发生过的事、不是输入框的一个状态：打满的那
 * 一刻说一次，过一会儿自己消失；之后每一次被静静吞掉的击键再说一次。没有它，
 * 输入框会在用户还在打字时不再接受任何东西，而屏幕上什么都不说。
 */

import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';

// 上限换成一个跟五份文案里都不一样、且带千分位的数。文案自己写死 10,000 时，
// 「说出来的数就是生效的数」那条永远成立，看不出它根本没读这个常量；而 12,345
// 这个形状还顺带钉住了 ICU 的数字格式化——占位换成裸的 {limit} 就少了逗号。
vi.mock('@breatic/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, CHAT_MESSAGE_MAX_CHARS: 12345 };
});

const { CHAT_MESSAGE_MAX_CHARS } = await import('@breatic/shared');
const { ChatComposer } = await import('@web/pages/project/chat/ChatComposer');
const { NOTICE_LINGERS_MS } = await import('@web/pages/project/chat/notice-timing');

/**
 * 渲染一个输入框，草稿内容由用例给。
 * @param draft - 输入框里现在有什么。
 */
function setup(draft: string): { fill: (next: string) => void } {
  const props = { onChange: vi.fn(), onSubmit: vi.fn(), onAbort: vi.fn() };
  const { rerender } = render(<ChatComposer draft={draft} {...props} />);
  return {
    fill: (next: string) => rerender(<ChatComposer draft={next} {...props} />),
  };
}

/**
 * The editor behind the box.
 * @returns The editor.
 */
function box(): Editor {
  const el = screen.getByTestId('chat-composer-box') as unknown as { editor?: Editor };
  if (!el.editor) throw new Error('no editor on the box');
  return el.editor;
}

/** 打满输入框，因为那一刻才是提示出现的时候。 */
function fillToLimit(): void {
  setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS - 1)).fill(
    'y'.repeat(CHAT_MESSAGE_MAX_CHARS),
  );
}

describe('输入框的上限', () => {
  it('cuts a paste past the limit down to it and says so', () => {
    setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS - 3));
    act(() => box().commands.focus('end'));

    fireEvent.paste(box().view.dom, {
      clipboardData: { files: [], getData: (type: string) => (type === 'text/plain' ? 'abcdef' : '') },
    });

    expect(box().state.doc.textContent).toBe(`${'y'.repeat(CHAT_MESSAGE_MAX_CHARS - 3)}abc`);
    expect(screen.getByTestId('chat-composer-limit')).toBeInTheDocument();
  });

  it('到了上限才说，说的是已经到了', () => {
    fillToLimit();

    expect(screen.getByTestId('chat-composer-limit')).toBeInTheDocument();
  });

  it('说出来的那个数就是真正生效的那个', () => {
    fillToLimit();

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

  it('打开一个本来就写满的草稿时不说话', () => {
    // 说的是刚刚发生的事。打开时就满着，不是这一刻发生的。
    setup('y'.repeat(CHAT_MESSAGE_MAX_CHARS));

    expect(screen.queryByTestId('chat-composer-limit')).not.toBeInTheDocument();
  });

  it('says it again when a full box turns a keystroke away', () => {
    vi.useFakeTimers();
    try {
      fillToLimit();
      act(() => {
        vi.advanceTimersByTime(NOTICE_LINGERS_MS);
      });
      expect(screen.queryByTestId('chat-composer-limit')).not.toBeInTheDocument();

      act(() => {
        const e = box();
        e.view.dispatch(e.state.tr.insertText('a', e.state.doc.content.size - 1));
      });

      expect(box().state.doc.textContent).not.toContain('a');
      expect(screen.getByTestId('chat-composer-limit')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('满了之后按方向键不说话——它本来就不产生字符', () => {
    vi.useFakeTimers();
    try {
      fillToLimit();
      const box = screen.getByTestId('chat-composer-box');
      act(() => {
        vi.advanceTimersByTime(NOTICE_LINGERS_MS);
      });

      fireEvent.keyDown(box, { key: 'ArrowLeft' });

      expect(screen.queryByTestId('chat-composer-limit')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
