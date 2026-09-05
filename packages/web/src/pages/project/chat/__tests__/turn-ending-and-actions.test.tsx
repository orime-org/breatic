// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reply says about how it ended, and what it offers afterwards.
 *
 * The line that says nothing came back has to mean it: a turn whose last act
 * was to show what it found produced something, and it is drawn directly
 * above that line. And the copy on a reader's own message appears on hover --
 * appears, rather than being there all along at zero opacity, which reserves
 * a strip under every message and leaves a control that can be pressed and
 * tabbed to with nothing visible there.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';

afterEach(cleanup);

describe('the line that says nothing came back', () => {
  it('stays away from a turn that found things but said nothing', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          assets: [{ kind: 'image', url: 'https://i.example/1.png', title: 'One' }],
        }}
      />,
    );

    expect(screen.getByTestId('asset-row')).toBeInTheDocument();
    expect(screen.queryByTestId('message-bubble-empty')).toBeNull();
  });

  it('stays away from a turn that found sources but said nothing', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          sources: [
            { url: 'https://a.example', title: 'A', publisher: 'A', index: 1 },
          ],
        }}
      />,
    );

    expect(screen.queryByTestId('message-bubble-empty')).toBeNull();
  });

  it('says it for a turn that only called tools and drew nothing', () => {
    // 工具行跑完就撤，所以一轮只有工具调用、搜索全空时屏幕上什么都没有。
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'web_search', args: {}, status: 'success' }],
        }}
      />,
    );

    expect(screen.getByTestId('message-bubble-empty')).toBeInTheDocument();
  });

  it('still says it when the turn produced nothing at all', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '' }} />);

    expect(screen.getByTestId('message-bubble-empty')).toBeInTheDocument();
  });
});

describe('the copy on a reader\'s own message', () => {
  it('cannot be pressed until it is hovered', () => {
    // The line is there whether or not the copy is showing; the copy itself
    // is what waits. Transparent alone would leave a blank that copies when
    // pressed and takes a tab stop with nothing visible on it.
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    const copy = screen.getByTestId('turn-copy');
    expect(copy.className).toMatch(/pointer-events-none/);
    expect(copy.className).toMatch(/group-hover:pointer-events-auto/);
  });

  it('sits on a line of its own under the bubble', () => {
    // Laid out rather than floated: a row that takes no space lets the reply
    // below it come up underneath, and the two are then drawn on top of each
    // other.
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    const actions = screen.getByTestId('turn-actions');
    expect(actions.className).not.toMatch(/\babsolute\b/);
  });

  it('keeps the bubble and its line in one thing to hover', () => {
    // The pointer travelling from the bubble to the button must not leave
    // whatever reveals the button, or the button goes away as it is reached.
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    const actions = screen.getByTestId('turn-actions');
    const stack = actions.parentElement;
    expect(stack?.className).toMatch(/\bgroup\b/);
    expect(stack?.querySelector('[data-testid="message-bubble-content"]')).not.toBeNull();
  });

  it('says when the message was sent, in the reader\'s own day', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'user',
          content: '找参考图',
          sentAt: '2026-09-05T02:30:00.000Z',
        }}
      />,
    );

    const stamp = screen.getByTestId('turn-sent-at');
    // Whatever the reader's locale writes, it is the local reading of that
    // instant rather than the string that arrived.
    expect(stamp.textContent).toBe(
      new Date('2026-09-05T02:30:00.000Z').toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
      }),
    );
  });

  it('is revealed by the bubble rather than by the width of the row', () => {
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    const row = screen.getByTestId('message-bubble');
    expect(row.className).not.toMatch(/\bgroup\b/);
    expect(row.firstElementChild?.className).toMatch(/\bgroup\b/);
  });

  it('leaves the tooltip to the browser no longer', () => {
    render(<MessageBubble message={{ id: 'm', role: 'user', content: '找参考图' }} />);

    expect(screen.getByTestId('turn-copy')).not.toHaveAttribute('title');
  });
});
