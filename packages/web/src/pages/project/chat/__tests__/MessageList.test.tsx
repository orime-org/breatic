// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MessageList } from '@web/pages/project/chat/MessageList';
import type { ChatMessage } from '@web/pages/project/chat/types';

describe('MessageList', () => {
  it('renders the empty state when there are no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
  });

  it('does NOT render the empty state when there are messages', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'Hello' },
    ];
    render(<MessageList messages={messages} />);
    expect(screen.queryByTestId('chat-empty')).toBeNull();
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1);
  });

  it('follows a reply as it grows, not only when a message is added', () => {
    // jsdom has no layout, so the call is what there is to observe. On
    // `HTMLElement` rather than `Element`, because another test file in this
    // run leaves its own copy on `HTMLElement.prototype` — nearer on the
    // chain from a div, so a spy on `Element` never sees the call.
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    const growing = (content: string): ChatMessage[] => [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'm2', role: 'assistant', content },
    ];
    const { rerender } = render(<MessageList messages={growing('Th')} />);
    scrollIntoView.mockClear();

    rerender(<MessageList messages={growing('That is a much longer answer')} />);

    // A streaming reply arrives as pieces appended to one message: the count
    // never changes. Watching only the count leaves any answer taller than
    // the column growing out of sight while the user waits for it.
    expect(scrollIntoView).toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it('stops following once the user has scrolled up to read', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});

    const growing = (content: string): ChatMessage[] => [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'm2', role: 'assistant', content },
    ];
    const { container, rerender } = render(<MessageList messages={growing('Th')} />);

    // jsdom lays nothing out, so the scroll position has to be stated. This
    // one is a long way from the bottom: the reader went back up.
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    Object.defineProperty(viewport, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(viewport, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true });
    scrollIntoView.mockClear();

    rerender(<MessageList messages={growing('That is a much longer answer')} />);

    // Dragging them back down once per token makes the column unreadable for
    // the whole turn, which is the window a long answer is worth reading in.
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });
});
