// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MessageList } from '@web/pages/project/chat/MessageList';
import type { ChatMessage } from '@web/pages/project/chat/types';

/**
 * Undos owed at the end of the current test, newest first.
 *
 * The stand-ins below sit on `HTMLElement.prototype` and on
 * `globalThis.ResizeObserver`, so an undo written at the end of a test body
 * is skipped the moment an assertion above it fails — and every later test in
 * the file then runs against geometry that was never put back, turning one
 * real failure into a column of them.
 */
const undos: Array<() => void> = [];

afterEach(() => {
  for (const undo of undos.splice(0).reverse()) undo();
});

/**
 * State the scroll geometry jsdom does not lay out, live.
 *
 * The object is read on every access, so a test can grow `scrollHeight` the
 * way appending content does in a browser — which is the moment the whole
 * question turns on.
 * @param geometry - The values to report, mutated by the caller as it goes
 * @returns The write counter and its reset
 */
function stateGeometry(geometry: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): { writes: () => number; reset: () => void } {
  let writes = 0;
  const keys = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
  const originals = keys.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  for (const k of keys) {
    Object.defineProperty(HTMLElement.prototype, k, {
      get: () => geometry[k],
      // scrollTop is the one the column writes to reach its end, so the
      // stand-in has to take a write the way a real element does; the other
      // two are read-only in a browser as well.
      set:
        k === 'scrollTop'
          ? function (this: HTMLElement, v: number) {
            geometry.scrollTop = v;
            // Only the message column's own scroller counts: this stand-in
            // sits on the prototype, so Radix writing scrollTop on any of
            // its internals would otherwise read as the column following.
            if (this.hasAttribute?.('data-radix-scroll-area-viewport')) writes += 1;
          }
          : undefined,
      configurable: true,
    });
  }
  undos.push(() => {
    for (const [k, d] of originals) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  });
  return {
    writes: () => writes,
    reset: () => {
      writes = 0;
    },
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
    // jsdom lays nothing out, so what there is to observe is the write the
    // column makes to reach its end. Sitting at the bottom to begin with:
    // 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);

    const growing = (content: string): ChatMessage[] => [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'm2', role: 'assistant', content },
    ];
    const { rerender } = render(<MessageList ready messages={growing('Th')} />);
    follow.reset();

    rerender(<MessageList ready messages={growing('That is a much longer answer')} />);

    // A streaming reply arrives as pieces appended to one message: the count
    // never changes. Watching only the count leaves any answer taller than
    // the column growing out of sight while the user waits for it.
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('opens on the newest message, not the oldest', () => {
    // A tall history, already laid out at the moment of the first render.
    const follow = stateGeometry({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });

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
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('keeps following a reader who never left the bottom', () => {
    // Sitting exactly at the bottom: 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList ready messages={[bubble('m1', 'Hello')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

    // Sending appends the user's bubble and the empty reply, and that content
    // is what makes the column taller — the reader has not moved.
    geometry.scrollHeight = 1088;
    rerender(
      <MessageList ready messages={[bubble('m1', 'Hello'), bubble('m2', ''), bubble('m3', '')]} />,
    );

    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('follows the bottom again in the conversation switched to', () => {
    // 上一条里读者往回翻过,那是关于**那一条**会话的。换到另一条,面板给出的是
    // 一段全新的对话,而它该从最后一句开始 —— 不是停在上一条被读到的地方。
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready conversationId='c-1' messages={[bubble('m1', 'first chat')]} />,
    );
    // 读者往回翻,跟随关掉。
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

    rerender(
      <MessageList ready conversationId='c-2' messages={[bubble('m9', 'another chat')]} />,
    );

    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('stops following once the user has scrolled up to read', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList ready messages={[bubble('m2', 'Th')]} />);
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    geometry.scrollTop = 0;
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

    geometry.scrollHeight = 2100;
    rerender(<MessageList ready messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Dragging them back down once per token makes the column unreadable for
    // the whole turn, which is the window a long answer is worth reading in.
    expect(follow.writes()).toBe(0);
  });

  it('follows the end of a turn, not only the words in it', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const follow = stateGeometry(geometry);

    const reply: ChatMessage = { id: 'm2', role: 'assistant', content: 'half an answer' };
    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'earlier'), reply]} sentCount={1} />,
    );
    // The reader is at the bottom and stays there.
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

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
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('does not read a background refetch as the reader sending something', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const said: ChatMessage = { id: 'local-user-abc', role: 'user', content: 'what about this' };
    const { container, rerender } = render(
      <MessageList
        ready
        messages={[said, bubble('local-reply-x', 'a partial')]}
        sentCount={1}
      />,
    );
    // Reading something further up.
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    geometry.scrollTop = 0;
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

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

    expect(follow.writes()).toBe(0);
  });

  it('does not read messages arriving from elsewhere as the reader sending', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={3} />,
    );
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    geometry.scrollTop = 0;
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

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

    expect(follow.writes()).toBe(0);
  });

  it('comes back to the bottom when the reader sends something themselves', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={0} />,
    );
    // Reading something further up.
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

    // Then they type into the composer and hit enter. The list does not
    // change: until the first frame arrives their own message is held out of
    // it (B1), and there is no reply yet. Sending is the only thing that
    // happened, so sending is what has to move the column -- an earlier
    // version of this case appended two messages in the same rerender, and
    // was satisfied by the count going up rather than by the press.
    geometry.scrollHeight = 2200;
    rerender(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={1} />,
    );

    // Scrolling up says "let me read". Sending says "show me what happens
    // next" — and if the column stays where it was, nothing on screen
    // changes at all: not their own message, not a word of the reply. They
    // have no way to tell it went anywhere.
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('picks following back up when the user returns to the bottom', () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(<MessageList ready messages={[bubble('m2', 'Th')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')!;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 1600;
    fireEvent.scroll(viewport);
    follow.reset();

    geometry.scrollHeight = 2100;
    rerender(<MessageList ready messages={[bubble('m2', 'That is a much longer answer')]} />);

    // Scrolling back down is how a reader says they want to follow again.
    expect(follow.writes()).toBeGreaterThan(0);
  });
});

describe('MessageList — when the column itself changes width', () => {
  /**
   * Swap in a ResizeObserver whose callbacks the test can fire by hand; the
   * setup file's stub observes nothing.
   * @returns The trigger and how many observers have been built
   */
  function observableResize(): { fire: () => void; built: () => number } {
    // Only observers that were actually pointed at something fire, so a
    // callback registered and then never wired up counts as not observing.
    const watching: ResizeObserverCallback[] = [];
    let built = 0;
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        built += 1;
      }
      observe(): void {
        watching.push(this.cb);
      }
      unobserve(): void {}
      disconnect(): void {
        const i = watching.indexOf(this.cb);
        if (i >= 0) watching.splice(i, 1);
      }
    };
    undos.push(() => {
      globalThis.ResizeObserver = original;
    });
    return {
      fire: () => {
        for (const cb of [...watching]) cb([], {} as ResizeObserver);
      },
      built: () => built,
    };
  }

  it('watches the column through one observer, however many messages arrive', () => {
    // The column asks the ScrollArea for its scroller instead of reaching for
    // it through a sentinel rendered after the last message. Reading it that
    // way tied the observer's lifetime to the message count: every message
    // tore it down and built another, and each new one fires once on being
    // pointed at something.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    stateGeometry(geometry);
    const resize = observableResize();

    const { rerender } = render(<MessageList ready messages={[bubble('m1', 'a')]} />);
    const afterFirstMessage = resize.built();

    rerender(<MessageList ready messages={[bubble('m1', 'a'), bubble('m2', 'b')]} />);
    rerender(
      <MessageList
        ready
        messages={[bubble('m1', 'a'), bubble('m2', 'b'), bubble('m3', 'c')]}
      />,
    );

    expect(resize.built()).toBe(afterFirstMessage);
  });

  it('goes back to the bottom for a reader who was already there', () => {
    // Sitting exactly at the bottom: 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    render(<MessageList ready messages={[bubble('m1', 'An answer')]} />);
    follow.reset();

    // A narrower column rewraps every line, so the same words are taller. The
    // browser leaves scrollTop where it was, which puts the reader 600px above
    // the end of a conversation they were reading the last line of.
    geometry.scrollHeight = 1600;
    resize.fire();

    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('gets there by writing its own viewport, not by asking to be scrolled into view', () => {
    // The project page is itself a horizontal scroller now, and an API that
    // walks up the tree takes the whole page with it: measured in a browser, a
    // page parked at scrollLeft 141 was dragged back to 11 by one call. jsdom
    // has no real scrolling, so what this pins is the write — that the column
    // reaches its end by setting scrollTop rather than by handing the job to
    // an API that also moves everything above it. Leaving the page alone is
    // verified on the real app.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    stateGeometry(geometry);
    const resize = observableResize();
    render(<MessageList ready messages={[bubble('m1', 'An answer')]} />);
    const viewport = screen
      .getByTestId('message-list')
      .querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;

    geometry.scrollHeight = 1600;
    resize.fire();

    expect(viewport.scrollTop).toBe(viewport.scrollHeight);
  });

  it('leaves a reader who scrolled up where they are', () => {
    // 1000 - 100 - 400 = 500 from the end: reading something further up.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    render(<MessageList ready messages={[bubble('m1', 'An answer')]} />);
    const viewport = screen
      .getByTestId('message-list')
      .querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    follow.reset();

    geometry.scrollHeight = 1600;
    resize.fire();

    expect(follow.writes()).toBe(0);
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
