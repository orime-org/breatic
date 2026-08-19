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
    render(<MessageList ready messages={[]} />);
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
  });

  it('does NOT render the empty state when there are messages', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'Hello' },
    ];
    render(<MessageList ready messages={messages} />);
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
    const { rerender } = render(<MessageList ready messages={growing('Th')} />);
    scrollIntoView.mockClear();

    rerender(<MessageList ready messages={growing('That is a much longer answer')} />);

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
        ready
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

    const { container, rerender } = render(<MessageList ready messages={[bubble('m1', 'Hello')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // Sending appends the user's bubble and the empty reply, and that content
    // is what makes the column taller — the reader has not moved.
    geometry.scrollHeight = 1088;
    rerender(
      <MessageList ready messages={[bubble('m1', 'Hello'), bubble('m2', ''), bubble('m3', '')]} />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('follows the bottom again in the conversation switched to', () => {
    // 上一条里读者往回翻过,那是关于**那一条**会话的。换到另一条,面板给出的是
    // 一段全新的对话,而它该从最后一句开始 —— 不是停在上一条被读到的地方。
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready conversationId='c-1' messages={[bubble('m1', 'first chat')]} />,
    );
    // 读者往回翻,跟随关掉。
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    rerender(
      <MessageList ready conversationId='c-2' messages={[bubble('m9', 'another chat')]} />,
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

    const { container, rerender } = render(<MessageList ready messages={[bubble('m2', 'Th')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    geometry.scrollHeight = 2100;
    rerender(<MessageList ready messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Dragging them back down once per token makes the column unreadable for
    // the whole turn, which is the window a long answer is worth reading in.
    expect(scrollIntoView).not.toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('follows the end of a turn, not only the words in it', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const restore = stateGeometry(geometry);

    const reply: ChatMessage = { id: 'm2', role: 'assistant', content: 'half an answer' };
    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'earlier'), reply]} sentCount={1} />,
    );
    // The reader is at the bottom and stays there.
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // The turn fails partway. Not one more word is written, but the bubble
    // grows: a failure box appears inside it. The same holds for the mark on
    // a turn that was stopped.
    geometry.scrollHeight = 2026;
    rerender(
      <MessageList
        ready
        messages={[bubble('m1', 'earlier'), { ...reply, failed: true }]}
        sentCount={1}
      />,
    );

    // Without this the reader sits at the bottom and cannot see the thing
    // that just told them what happened to their answer.
    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('does not read a background refetch as the reader sending something', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const said: ChatMessage = { id: 'local-user-abc', role: 'user', content: 'what about this' };
    const { container, rerender } = render(
      <MessageList
        ready
        messages={[said, bubble('local-reply-x', 'a partial')]}
        sentCount={1}
      />,
    );
    // Reading something further up.
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // The network comes back and the conversation is fetched again. Every
    // message is the same message, but the two the panel had made up ids for
    // now carry the server's, and the reply arrives in the form the server
    // stored it. Nothing here was done by the reader. Reading the changed id
    // as "they just sent something" pulls them out of what they were reading.
    geometry.scrollHeight = 2010;
    rerender(
      <MessageList
        ready
        messages={[
          { ...said, id: 'srv-77' },
          bubble('srv-78', 'a partial answer, in full'),
        ]}
        sentCount={1}
      />,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('does not read messages arriving from elsewhere as the reader sending', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={3} />,
    );
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // The same person, in another tab of the same project, says something.
    // This tab asks the server for the conversation again and the list grows
    // by a turn they did not type here. More messages is not the same event
    // as this reader pressing send, and only the second should take them out
    // of what they are reading.
    geometry.scrollHeight = 2400;
    rerender(
      <MessageList
        ready
        messages={[
          bubble('m1', 'an earlier answer'),
          { id: 'srv-90', role: 'user', content: 'sent from the other tab' },
          bubble('srv-91', 'and its answer'),
        ]}
        sentCount={3}
      />,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('comes back to the bottom when the reader sends something themselves', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={0} />,
    );
    // Reading something further up.
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    scrollIntoView.mockClear();

    // Then they type into the composer and hit enter: the count goes up, and
    // their own message and the reply about to be written are appended.
    geometry.scrollHeight = 2200;
    rerender(
      <MessageList
        ready
        messages={[
          bubble('m1', 'an earlier answer'),
          { id: 'm2', role: 'user', content: 'what about this' },
          bubble('m3', ''),
        ]}
        sentCount={1}
      />,
    );

    // Scrolling up says "let me read". Sending says "show me what happens
    // next" — and if the column stays where it was, nothing on screen
    // changes at all: not their own message, not a word of the reply. They
    // have no way to tell it went anywhere.
    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });

  it('picks following back up when the user returns to the bottom', () => {
    const scrollIntoView = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const restore = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList ready messages={[bubble('m2', 'Th')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')!;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 1600;
    fireEvent.scroll(viewport);
    scrollIntoView.mockClear();

    geometry.scrollHeight = 2100;
    rerender(<MessageList ready messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Scrolling back down is how a reader says they want to follow again.
    expect(scrollIntoView).toHaveBeenCalled();
    restore();
    scrollIntoView.mockRestore();
  });
});

describe('the skeleton that stands in while messages are on their way', () => {
  it('is shaped like the lines of a conversation, not like blocks', () => {
    // demo 定的是「形状照着真实消息排」:每组一条右对齐的短行(用户说的),
    // 底下两条左对齐的长行(回复的两行),一共三组、逐组变宽。方块堆在那里
    // 读不出是对话,只读得出「有东西在闪」。
    const { container } = render(<MessageList ready={false} skeleton messages={[]} />);
    const bars = container.querySelectorAll('[data-testid="message-skeleton"] [data-skeleton-bar]');

    expect(bars).toHaveLength(9);
    // 每组第一条是用户那句,靠右;底下两条是回答,靠左。三条一样高(h-3,跟仓里
    // 其他 Skeleton 一个刻度),问答之分靠左右和宽度,不靠高度。
    const first = bars[0] as HTMLElement;
    expect(first.className).toContain('ml-auto');
    expect((bars[1] as HTMLElement).className).not.toContain('ml-auto');
  });
});
