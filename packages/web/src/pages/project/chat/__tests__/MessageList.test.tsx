// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

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
  // jsdom implements no scrolling at all, so the journey the way-back button
  // starts has nothing to call. Left out, it throws inside React's dispatch
  // and vitest reports the run as failed with every test passing -- the exit
  // code says 1 while the count says green.
  const hadScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    value: function (this: HTMLElement, options: { top: number }) {
      // A browser's smooth journey ends where it was told to go, and raises
      // the scroll events on the way itself. Here it simply arrives, and the
      // test raises whichever events the case is about.
      this.scrollTop = options.top;
    },
    configurable: true,
    writable: true,
  });
  undos.push(() => {
    for (const [k, d] of originals) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
    if (hadScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', hadScrollTo);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
  });
  return {
    writes: () => writes,
    reset: () => {
      writes = 0;
    },
  };
}

/**
 * Let the library finish what it started.
 *
 * Following runs down a chain of animation frames, and the judgement about
 * whether a scroll was the reader's own is made in a timer a millisecond out.
 * A synchronous assertion reads the column before either has happened, so
 * every case that turns on one of them waits here first.
 * @returns A promise that settles once both have run.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
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

/**
 * Count the times anything asks to be scrolled into view.
 *
 * jsdom has no such method at all, so the stand-in is both the recorder and
 * the implementation; a column that reached for it would throw without one.
 * @returns How many calls it recorded.
 */
function watchScrollIntoView(): { calls: () => number } {
  let calls = 0;
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: () => {
      calls += 1;
    },
    configurable: true,
    writable: true,
  });
  undos.push(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
  });
  return { calls: () => calls };
}

describe('MessageList', () => {
  it('renders the empty state when there are no messages', () => {
    render(<MessageList ready messages={[]} />);
    expect(screen.getByTestId('chat-empty')).toBeInTheDocument();
  });

  it('keeps the empty state out of the message list scroller', () => {
    // It centres itself with `h-full`, and Radix's viewport cannot give it
    // one: the wrapper inside it is an auto-height block, so a percentage
    // height resolves against the content and the centring collapses to the
    // top of the column — measured at 514px of empty panel below it, 63% of
    // the column, with the greeting's own arrow pointing into it. Layout is
    // not computed here, so what this pins is the arrangement that causes it.
    //
    // THIS scroller, named, rather than any scroll viewport: the project page
    // is itself inside a horizontal one (#169), so on the real page the empty
    // state is inside a Radix viewport and always will be.
    render(<MessageList ready messages={[]} />);

    const empty = screen.getByTestId('chat-empty');
    expect(empty.closest('[data-testid="message-list"]')).toBeNull();
  });

  it('does NOT render the empty state when there are messages', () => {
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'Hello' },
    ];
    render(<MessageList ready messages={messages} />);
    expect(screen.queryByTestId('chat-empty')).toBeNull();
    expect(screen.getAllByTestId('message-bubble')).toHaveLength(1);
  });

  it('follows a reply as it grows, not only when a message is added', async () => {
    // jsdom lays nothing out, so what there is to observe is the write the
    // column makes to reach its end. Sitting at the bottom to begin with:
    // 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const growing = (content: string): ChatMessage[] => [
      { id: 'm1', role: 'user', content: 'Hello' },
      { id: 'm2', role: 'assistant', content },
    ];
    const { rerender } = render(<MessageList ready messages={growing('Th')} />);
    follow.reset();

    rerender(<MessageList ready messages={growing('That is a much longer answer')} />);
    // The words landing is what makes the column taller, and the column hears
    // about that from the box it is laid out in rather than from the props.
    geometry.scrollHeight = 1400;
    resize.fire();

    // A streaming reply arrives as pieces appended to one message: the count
    // never changes. Watching only the count leaves any answer taller than
    // the column growing out of sight while the user waits for it.
    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('opens on the newest message, not the oldest', async () => {
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
    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('keeps following a reader who never left the bottom', async () => {
    // Sitting exactly at the bottom: 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container, rerender } = render(<MessageList ready messages={[bubble('m1', 'Hello')]} />);
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    follow.reset();

    // Sending appends the user's bubble and the empty reply, and that content
    // is what makes the column taller — the reader has not moved. The column
    // hears about the extra height from the box the messages are laid out in,
    // so the rerender alone says nothing until that box reports its new size.
    geometry.scrollHeight = 1088;
    rerender(
      <MessageList ready messages={[bubble('m1', 'Hello'), bubble('m2', ''), bubble('m3', '')]} />,
    );
    resize.fire();

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('follows the bottom again in the conversation switched to', async () => {
    // 上一条里读者往回翻过,那是关于**那一条**会话的。换到另一条,面板给出的是
    // 一段全新的对话,而它该从最后一句开始 —— 不是停在上一条被读到的地方。
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready conversationId='c-1' messages={[bubble('m1', 'first chat')]} />,
    );
    // Mounting takes the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    await settle();
    geometry.scrollTop = 0;
    // 读者往回翻,跟随关掉。
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    await settle();
    follow.reset();

    rerender(
      <MessageList ready conversationId='c-2' messages={[bubble('m9', 'another chat')]} />,
    );

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('leaves the way-back button behind in the conversation it belonged to', async () => {
    // Where the reader stood is a fact about the exchange they were reading.
    // Carried across, it offers a way back to the end of a conversation that is
    // no longer on screen -- and the count beside it is the difference between
    // two different conversations' lengths.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready conversationId='c-1' messages={[bubble('m1', 'first chat')]} />,
    );
    // The column took itself to the end as it mounted, so leaving it is a move
    // the reader makes from there.
    await settle();
    geometry.scrollTop = 0;
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    await settle();
    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();

    rerender(
      <MessageList ready conversationId='c-2' messages={[bubble('m9', 'another chat')]} />,
    );

    await settle();
    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();
  });

  it('hears the reader scroll in the conversation they arrived in', async () => {
    // The fourth reading of where they stood. The reader presses the way back,
    // and while the column is still travelling they land in another
    // conversation -- one short enough that its end is where the column
    // already is. Scrolling up in that conversation has to stop the column
    // following and offer the way back, exactly as it would in any other.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready conversationId='c-1' messages={[bubble('m1', 'first chat')]} />,
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;

    await settle();
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();
    fireEvent.click(screen.getByTestId('back-to-latest'));

    // Short enough that going to its end writes the value already there.
    geometry.scrollHeight = 400;
    geometry.scrollTop = 0;
    rerender(<MessageList ready conversationId='c-2' messages={[bubble('m9', 'second chat')]} />);
    await settle();

    // It grows past the viewport, and the reader scrolls up in it.
    geometry.scrollHeight = 2000;
    geometry.scrollTop = 400;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();

    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();
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

  it('follows the end of a turn, not only the words in it', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

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
    resize.fire();

    // Without this the reader sits at the bottom and cannot see the thing
    // that just told them what happened to their answer.
    await settle();
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

  it('comes back to the bottom when the reader sends something themselves', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'an earlier answer')]} sentCount={0} />,
    );
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    await settle();
    // Reading something further up.
    geometry.scrollTop = 0;
    fireEvent.scroll(container.querySelector('[data-radix-scroll-area-viewport]')!);
    await settle();
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
    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('picks following back up when the user returns to the bottom', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container, rerender } = render(<MessageList ready messages={[bubble('m2', 'Th')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]')!;
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: the distance is what the column reads.
    await settle();
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();
    geometry.scrollTop = 1600;
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    geometry.scrollHeight = 2100;
    rerender(<MessageList ready messages={[bubble('m2', 'That is a much longer answer')]} />);
    resize.fire();

    // Scrolling back down is how a reader says they want to follow again.
    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });
});

/**
 * Swap in a ResizeObserver whose callbacks the test can fire by hand; the
 * setup file's stub observes nothing.
 * @returns The trigger, how many observers have been built, and what they watch
 */
function observableResize(): {
  fire: (match?: (target: Element) => boolean) => void;
  built: () => number;
  } {
  // Only observers that were actually pointed at something fire, so a
  // callback registered and then never wired up counts as not observing.
  // Paired with what each was pointed at, so a test can say which element
  // changed size -- the answer turns on that and not on how many fired.
  const watching: Array<{ cb: ResizeObserverCallback; target: Element }> = [];
  let built = 0;
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      built += 1;
    }
    observe(target: Element): void {
      watching.push({ cb: this.cb, target });
    }
    unobserve(): void {}
    disconnect(): void {
      for (let i = watching.length - 1; i >= 0; i -= 1) {
        if (watching[i]?.cb === this.cb) watching.splice(i, 1);
      }
    }
  };
  undos.push(() => {
    globalThis.ResizeObserver = original;
  });
  return {
    fire: (match) => {
      for (const w of [...watching]) {
        if (match && !match(w.target)) continue;
        // Both observers read the height off the entry rather than off the
        // element, so an empty batch throws before it gets as far as the
        // question the test is asking. Which height it is depends on which
        // box was observed: the scroller reports the room it has, everything
        // else reports how tall it drew itself.
        const isViewport = w.target.hasAttribute('data-radix-scroll-area-viewport');
        const height = isViewport ? w.target.clientHeight : w.target.scrollHeight;
        const entry = { target: w.target, contentRect: { height } };
        w.cb([entry] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
      }
    },
    built: () => built,
  };
}

describe('MessageList — when the column itself changes width', () => {
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

  it('goes back to the bottom for a reader who was already there', async () => {
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

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('gets there by writing its own viewport, not by asking to be scrolled into view', async () => {
    // The project page is itself a horizontal scroller now, and an API that
    // walks up the tree takes the whole page with it: measured in a browser, a
    // page parked at scrollLeft 141 was dragged back to 11 by one call. jsdom
    // has no real scrolling, so what this pins is which of the two the column
    // uses — its own scrollTop, not the API that also moves everything above
    // it. Where the write lands is the neighbouring case; leaving the page
    // alone is verified on the real app.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const intoView = watchScrollIntoView();
    const resize = observableResize();
    render(<MessageList ready messages={[bubble('m1', 'An answer')]} />);
    follow.reset();

    geometry.scrollHeight = 1600;
    resize.fire();

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
    expect(intoView.calls()).toBe(0);
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

describe('the way back to the newest message', () => {
  it('stays out of the way while the reader is at the end', () => {
    stateGeometry({ scrollHeight: 500, clientHeight: 500, scrollTop: 0 });
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();
  });

  it('offers a way back once the reader has left the end', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    // Dragging up raises an event at every step of the way, and where the
    // reader came from is what says the move was upwards at all -- so the
    // first of them stands for the place they left.
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) fireEvent.scroll(viewport);
    geometry.scrollTop = 200;
    if (viewport) fireEvent.scroll(viewport);
    await settle();

    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();
  });

  it('is a circle carrying an arrow, and nothing else', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) fireEvent.scroll(viewport);
    geometry.scrollTop = 200;
    if (viewport) fireEvent.scroll(viewport);
    await settle();

    const back = screen.getByTestId('back-to-latest');
    expect(back.className).toMatch(/rounded-full/);
    expect(back.textContent).toBe('');
    expect(back.querySelector('svg')).not.toBeNull();
    // Square, so the circle is a circle.
    expect(back.className).toMatch(/\bsize-\[var\(--btn-inline\)\]/);
  });

  it('goes away once the reader is back at the end', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    // The column takes itself to the end as it mounts, so leaving it is a
    // move the reader makes afterwards, and the event raised where they were
    // standing is what makes the next one a move upwards.
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]');
    if (viewport) fireEvent.scroll(viewport);
    geometry.scrollTop = 200;
    if (viewport) fireEvent.scroll(viewport);
    await settle();
    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();

    geometry.scrollTop = 1600;
    if (viewport) fireEvent.scroll(viewport);
    await settle();
    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();
  });

  it('glides the column back, and stays out of the way while it travels', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const follow = stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')!;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    fireEvent.click(screen.getByTestId('back-to-latest'));
    // The journey raises a scroll event at every step, and every one of them
    // is far from the end until the last. Reading those as the reader moving
    // would put the button back on screen for the length of the journey.
    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();

    // Arriving is the part that is the reader's: wherever the journey is up
    // to, the end is where it ends. How many steps it took to get there is
    // the library's business and is measured on the running app, where
    // frames are real -- here they are a timer, and counting them measures
    // the machine. 70px is the library's own reading of "at the end"
    // (`STICK_TO_BOTTOM_OFFSET_PX`), the distance inside which it stops
    // offering a way back; a spring settles a few pixels short of zero.
    await waitFor(() => {
      expect(geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight).toBeLessThan(70);
    });
    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();
  });

  it('hands the column back when the reader takes over mid-journey', async () => {
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')!;
    fireEvent.scroll(viewport);
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();
    fireEvent.click(screen.getByTestId('back-to-latest'));

    // The journey is under way: a smooth scroll raises an event per frame, and
    // each of them moves towards the end.
    geometry.scrollTop = 900;
    fireEvent.scroll(viewport);

    // A browser stops its own scrolling the moment the reader scrolls, so a
    // journey that is called off never reaches the end -- and the column has
    // to notice, or it never listens to this reader again. Moving away from
    // the end is what says so, whatever they scrolled with: the journey only
    // ever moves towards it.
    geometry.scrollTop = 300;
    fireEvent.scroll(viewport);
    await settle();

    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();
  });

  it('hears the reader when the journey stopped short of the end', async () => {
    // The column can grow while the journey travels -- a chunk arriving, a
    // picture row measuring itself -- so where the journey lands is no longer
    // the end, and arrival is the only other thing that ends it. Moving away
    // from the end has to end it too, or this reader is never heard from again.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 0 };
    stateGeometry(geometry);
    render(<MessageList ready messages={[bubble('a', 'hi')]} />);

    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')!;
    // Mounting took the column to its end, so leaving it is a move from there.
    await settle();
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();
    fireEvent.click(screen.getByTestId('back-to-latest'));

    // The journey raises an event at every step. It gets as far as 2000, and
    // by then the column is 3000 tall.
    geometry.scrollHeight = 3000;
    geometry.scrollTop = 2000;
    fireEvent.scroll(viewport);

    geometry.scrollTop = 100;
    fireEvent.scroll(viewport);
    await settle();

    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();
  });

  it('follows again for the reader who scrolled up and then sent something', async () => {
    // Sending says "show me what happens next", so the column takes itself to
    // the end and stays there. Going there once is the visible half; staying
    // is what the reply depends on, and this reads the second half: the words
    // that arrive after the press still have to bring the end into view.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { rerender } = render(
      <MessageList ready sentCount={0} messages={[bubble('m1', 'Hello')]} />,
    );
    const viewport = document.querySelector('[data-radix-scroll-area-viewport]')!;
    await settle();
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();

    rerender(<MessageList ready sentCount={1} messages={[bubble('m1', 'Hello')]} />);
    await settle();
    follow.reset();

    // The reply arrives after the press, and the column has to keep up with it.
    geometry.scrollHeight = 1400;
    rerender(
      <MessageList ready sentCount={1} messages={[bubble('m1', 'Hello'), bubble('m2', 'Hi')]} />,
    );
    resize.fire();
    await settle();

    expect(follow.writes()).toBeGreaterThan(0);
  });
});

describe('MessageList — when the content settles its own height', () => {
  it('follows the end when the content grows and the scroller does not', async () => {
    // A row of pictures decides its own height after it is on screen: it draws
    // at a floor width on the first frame and again at the width it measures
    // once it knows the room it has. Nothing the column already follows moves
    // when that happens -- the message count is the same, the last bubble's
    // shape is the same, and the scroller's own box is the size it always was --
    // so a reader sitting at the end is left above the row that just grew, with
    // the controls for that turn below the fold. Reaching them took a drag.
    //
    // Sitting exactly at the bottom: 1000 - 600 - 400 = 0.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    render(<MessageList ready messages={[bubble('m1', 'Here is what I found')]} />);
    const viewport = screen
      .getByTestId('message-list')
      .querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    follow.reset();

    // Only the content changed size. Watching the scroller alone cannot see
    // this, which is the whole of what went wrong: the ScrollArea watches the
    // content too, for its own scrollbar, so something fires either way and
    // firing is not the evidence -- reaching the end is.
    geometry.scrollHeight = 1400;
    resize.fire((target) => target !== viewport);

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('watches the column that replaces the greeting, in a conversation that started empty', async () => {
    // An empty conversation draws the greeting instead of the scroller, so
    // there is nothing to attach to on the first pass. The first message
    // brings the scroller with it -- and neither the ready flag nor the
    // callback changes as it arrives, so an effect keyed on those alone never
    // runs again: no scroll listener, no observers, for the life of that
    // conversation. It is the ordinary path: open a new conversation, ask for
    // pictures, watch the row arrive.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { rerender } = render(<MessageList ready messages={[]} />);
    rerender(<MessageList ready messages={[bubble('m1', 'Here is what I found')]} />);

    const viewport = screen
      .getByTestId('message-list')
      .querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    follow.reset();

    geometry.scrollHeight = 1400;
    resize.fire((target) => target !== viewport);

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('follows the end when the scroller shrinks and the content does not', async () => {
    // The other box the same observer watches. A column that gets shorter --
    // the window, the composer growing a line, a panel taking room -- leaves
    // the content's own box untouched: same messages, same widths, same
    // heights. Nothing else notices either, so the reader who was at the end
    // is left looking at the middle of the last reply with no event to say so.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    // Settled first: mounting starts its own journey to the end, and a case
    // that measures while that is still in flight is reading the mount, not
    // the resize.
    await settle();
    follow.reset();

    // The composer taking a second line: 2000 - 1600 - 360 = 40 from the end,
    // still within the slack that counts as being at it.
    geometry.clientHeight = 360;
    resize.fire((target) => target === viewport);

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('leaves a reader who is reading further up where they are', async () => {
    // The other half of the same guard, and the one that says what it is for:
    // a reader who went up to look at something earlier types a line into the
    // composer, and the column must not take that as licence to haul them
    // back to the newest message.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 200 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    // Mounting took the column to its end, so put the reader back up it
    // before saying they scrolled: 1400 from the end is where they read.
    await settle();
    geometry.scrollTop = 200;
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    geometry.clientHeight = 360;
    resize.fire((target) => target === viewport);
    await settle();

    expect(follow.writes()).toBe(0);
    expect(geometry.scrollTop).toBe(200);
  });

  it('keeps following a reader at the end when the scroller grows taller', async () => {
    // The composer collapsing back to one line, a notice going away, the
    // window being pulled taller: the column gets more room, and the browser
    // clamps scrollTop down to fit before it says anything. Measured in a
    // browser: a column parked at 800 in a 200px viewport was moved to 600
    // when the viewport went to 400, and that one scroll event was the whole
    // of what it said -- an event that reads exactly like the reader moving
    // upwards, while nothing about the reader changed at all.
    //
    // Order matters here and is the browser's. Measured with a real one
    // (`engineering/demo/2026-09-12-248-probe-resize-scroll-order.mjs`): the size
    // change is observed first, the scroll event second, and the call about
    // whether it was the reader's a millisecond after that. So by the time
    // the event lands, the column already knows the room changed.
    const geometry = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container, rerender } = render(
      <MessageList ready messages={[bubble('m1', 'A reply')]} />,
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    // Parked at the end: 1000 - 800 - 200 = 0.
    geometry.scrollTop = 800;
    fireEvent.scroll(viewport);

    geometry.clientHeight = 400;
    geometry.scrollTop = 600;
    resize.fire((target) => target === viewport);
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    // The next chunk still has to bring the end into view.
    geometry.scrollHeight = 1400;
    rerender(<MessageList ready messages={[bubble('m1', 'A reply, and more of it')]} />);
    resize.fire((target) => target !== viewport);

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('stays at the end for a reader whose composer took the room away', async () => {
    // Losing room is the half a browser says nothing about: scrollTop is
    // still legal, so nothing is clamped and no scroll event is raised, and
    // the content box did not change either. Measured on the running app: a
    // reader parked at the end who types eight lines grows the composer by
    // 137px and is left 137px above the end of the reply, with no arrow --
    // the end of that turn, and its copy button, under the composer.
    const geometry = { scrollHeight: 2118, clientHeight: 703, scrollTop: 1415 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    // Parked at the end: 2118 - 1415 - 703 = 0.
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    geometry.clientHeight = 566;
    resize.fire((target) => target === viewport);
    await settle();

    expect(follow.writes()).toBeGreaterThan(0);
    expect(geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight).toBeLessThan(2);
  });

  it('stays at the end for a reader who had nudged a few pixels up', async () => {
    // A nudge of less than the library's own 70px is a reader it still counts
    // as being at the end: no way back is offered, because there is nowhere
    // to go. The lock, though, is off -- so a guard that asks the lock leaves
    // exactly these readers behind when the composer then takes the room, and
    // they get neither the follow nor the arrow. Reading the distance instead
    // covers both, because 70px is the line the arrow is drawn from.
    const geometry = { scrollHeight: 2118, clientHeight: 703, scrollTop: 1415 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    await settle();

    // Thirty pixels up: off the lock, still counted as at the end.
    geometry.scrollTop = 1385;
    fireEvent.scroll(viewport);
    await settle();
    expect(screen.queryByTestId('back-to-latest')).not.toBeInTheDocument();
    follow.reset();

    geometry.clientHeight = 566;
    resize.fire((target) => target === viewport);
    await settle();

    expect(follow.writes()).toBeGreaterThan(0);
    expect(geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight).toBeLessThan(
      70,
    );
  });

  it('lets go of the end the moment the reader takes the scrollbar', async () => {
    // Whether a scroll was the reader's is judged a millisecond out, and that
    // judgement is skipped for any event raised while a resize is marked --
    // which is every frame a chunk lands in. The wheel has its own way past
    // it, read synchronously as the event arrives; a press on the scrollbar
    // raises one scroll event and nothing else, so landing in that window
    // leaves the press doing nothing at all. Measured on the running app:
    // 3 of 15 single writes mid-turn were undone. The press itself is the
    // signal, and it arrives before the scroll it causes.
    const geometry = { scrollHeight: 3000, clientHeight: 400, scrollTop: 2600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    await settle();

    const rail = container.querySelector('[data-scrollable]') as HTMLElement;
    expect(rail).not.toBeNull();
    fireEvent.pointerDown(rail);
    follow.reset();

    // The next chunk lands. A reader with their hand on the bar is placing
    // the column themselves, and it is no longer the turn's to move.
    geometry.scrollHeight = 3400;
    resize.fire((target) => target !== viewport);
    await settle();

    expect(follow.writes()).toBe(0);
  });

  it('keeps following a reader whose press on the bar moved nothing', async () => {
    // A press on the thumb itself moves no content -- the rail's own contract
    // says so ("thumb press -> relative drag (press itself never moves
    // content)") -- so it raises no scroll event either. Letting go of the
    // end on that press strands the reader: they are still at the end, the
    // reply stops arriving under them, and the way back stays hidden until
    // the turn has already run past them, because the only thing that puts
    // the lock back is a scroll event and there is none to come.
    const geometry = { scrollHeight: 3000, clientHeight: 400, scrollTop: 2600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    await settle();

    const rail = container.querySelector('[data-scrollable]') as HTMLElement;
    const thumb = rail.firstElementChild as HTMLElement;
    expect(thumb).not.toBeNull();
    fireEvent.pointerDown(thumb);
    follow.reset();

    geometry.scrollHeight = 3400;
    resize.fire((target) => target !== viewport);
    await settle();

    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('keeps following when the press was inside something else that scrolls', async () => {
    // A table or a block of maths wide enough to need its own scroller sits
    // inside the column, and its rail is a rail too. A reader dragging that
    // one sideways has not said anything about where they want the column,
    // and taking it as such would stop the reply arriving under them.
    const geometry = { scrollHeight: 3000, clientHeight: 400, scrollTop: 2600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    await settle();

    // Stand in for the nested scroller's rail: what marks it out is that it
    // lives inside the viewport, where the column's own rail does not.
    const inner = document.createElement('div');
    inner.setAttribute('data-scrollable', 'true');
    viewport.append(inner);
    fireEvent.pointerDown(inner);
    follow.reset();

    geometry.scrollHeight = 3400;
    resize.fire((target) => target !== viewport);
    await settle();

    expect(follow.writes()).toBeGreaterThan(0);
  });

  it('hears the reader again once the room has finished changing', async () => {
    // The mark that says "this scroll was the room changing, not the reader"
    // has to come back off, and nothing else puts it back: left on, every
    // scroll for the rest of the conversation reads as the room changing, so
    // a reader scrolling up is never noticed -- no way back offered, and the
    // column following a reply out from under them.
    const geometry = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container } = render(<MessageList ready messages={[bubble('m1', 'A reply')]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    geometry.scrollTop = 800;
    fireEvent.scroll(viewport);

    // The room grows, and the clamp that follows is not the reader moving.
    geometry.clientHeight = 400;
    geometry.scrollTop = 600;
    resize.fire((target) => target === viewport);
    fireEvent.scroll(viewport);
    await settle();

    // Now the reader really does scroll up, and is heard.
    geometry.scrollTop = 100;
    fireEvent.scroll(viewport);
    await settle();
    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();

    follow.reset();
    geometry.scrollHeight = 1400;
    resize.fire((target) => target !== viewport);
    await settle();
    expect(follow.writes()).toBe(0);
  });

  it('leaves the column where it is when the reader opened the thing that grew', async () => {
    // The same signal, from the opposite direction. A picture row measuring
    // itself is nobody's doing and wants the end back in view; a fold the
    // reader just pressed is the thing they want to look at, and following
    // takes it off the top of the screen. Measured in a browser with a
    // paragraph in the middle of the viewport grown by 400px: the browser left
    // scrollTop alone for one frame, then the follow wrote it 400 higher and
    // the paragraph went from 247px down the viewport to 153px above it.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const thinker: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'A reply',
      thinking: 'Working it out.',
    };
    const { container } = render(<MessageList ready messages={[thinker]} />);
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    await settle();
    follow.reset();

    // They open the fold, and the column grows because of it.
    fireEvent.click(screen.getByTestId('thinking-fold-toggle'));
    geometry.scrollHeight = 1400;
    resize.fire((target) => target !== viewport);
    await settle();

    expect(follow.writes()).toBe(0);
  });

  it('watches the messages, not the skeleton that stood in for them', async () => {
    // The content element either side of `ready` is a different one: the
    // skeleton first, the messages after. An effect that does not hear the
    // flag turn keeps watching the element that was taken off the screen, and
    // the turn whose pictures settle their height arrives in the other one.
    const geometry = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
    const follow = stateGeometry(geometry);
    const resize = observableResize();

    const { container, rerender } = render(
      <MessageList messages={[]} skeleton />,
    );
    rerender(<MessageList ready messages={[bubble('m1', 'Here it is')]} />);

    const viewport = container.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    fireEvent.scroll(viewport);
    follow.reset();

    geometry.scrollHeight = 1400;
    resize.fire((target) => target !== viewport);

    await settle();
    expect(follow.writes()).toBeGreaterThan(0);
  });


  it('gives a conversation that started empty its way back, too', async () => {
    // The scroll listener is attached by that same effect, so the conversation
    // opened from the greeting is also the one where nothing records the
    // reader leaving the end: following never switches off, and the arrow that
    // offers a return never appears. Measured in the running app on a turn
    // that was streaming, with the listener never attached: eight attempts to
    // look up, six of them dragged back to the end within three frames -- the
    // two that held were the two where the reply happened not to grow -- and
    // the arrow absent in all eight.
    const geometry = { scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 };
    stateGeometry(geometry);

    const { rerender } = render(<MessageList ready messages={[]} />);
    rerender(<MessageList ready messages={[bubble('m1', 'Here is what I found')]} />);

    const viewport = screen
      .getByTestId('message-list')
      .querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;

    // Where they were, then where they went: the pair is what makes the move
    // an upward one.
    fireEvent.scroll(viewport);
    geometry.scrollTop = 0;
    fireEvent.scroll(viewport);
    await settle();

    expect(screen.getByTestId('back-to-latest')).toBeInTheDocument();
  });
});
