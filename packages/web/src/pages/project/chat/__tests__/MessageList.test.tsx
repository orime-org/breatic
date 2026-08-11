// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MessageList } from '@web/pages/project/chat/MessageList';
import type { ChatMessage } from '@web/pages/project/chat/types';

/**
 * State the scroll geometry jsdom does not lay out, live.
 *
 * The object is read on every access, so a test can grow `scrollHeight` the
 * way appending content does in a browser — which is the moment the whole
 * question turns on.
 * @param geometry - The values to report, mutated by the caller as it goes
 * @returns Undo, to be called before the test ends
 */
function stateGeometry(geometry: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): () => void {
  const keys = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
  const originals = keys.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  for (const k of keys) {
    Object.defineProperty(HTMLElement.prototype, k, { get: () => geometry[k], configurable: true });
  }
  return () => {
    for (const [k, d] of originals) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  };
}

/**
 * One message, for the scroll tests where only its presence matters.
 * @param id - Its id
 * @param content - What it says
 * @returns The message
 */
function bubble(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content };
}

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

  it('opens on the newest message, not the oldest', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    // A tall history, already laid out at the moment of the first render.
    const restore = stateGeometry({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });

    render(
      <MessageList
        messages={Array.from({ length: 20 }, (_, i) => ({
          id: `m${i}`,
          role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `line ${i}`,
        }))}
      />,
    );

    // Measuring after the fact gets this exact case wrong: all of that
    // content counts as distance, and the reader is left looking at the start
    // of a conversation they have already read.
    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('keeps following a reader who never left the bottom', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    // Sitting exactly at the bottom: 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList messages={[bubble('m1', 'Hello')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // Sending appends the user's bubble and the empty reply, and that content
    // is what makes the column taller — the reader has not moved.
    geometry.scrollHeight = 1088;
    rerender(
      <MessageList messages={[bubble('m1', 'Hello'), bubble('m2', ''), bubble('m3', '')]} />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('stops following once the user has scrolled up to read', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList messages={[bubble('m2', 'Th')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    geometry.scrollHeight = 2100;
    rerender(<MessageList messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Dragging them back down once per token makes the column unreadable for
    // the whole turn, which is the window a long answer is worth reading in.
    expect(scrollIntoView).not.toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('picks following back up when the user returns to the bottom', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList messages={[bubble('m2', 'Th')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')!;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 1600;
    fireEvent.scroll(viewport);
    scrollIntoView.mockClear();

    geometry.scrollHeight = 2100;
    rerender(<MessageList messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Scrolling back down is how a reader says they want to follow again.
    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });
});
