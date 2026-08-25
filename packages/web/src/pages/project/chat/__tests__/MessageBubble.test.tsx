// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(message: ChatMessage) {
  return render(<MessageBubble message={message} />);
}

describe('MessageBubble', () => {
  it('renders user role bubbles right-aligned', () => {
    setup({ id: 'm1', role: 'user', content: 'hi' });
    const b = screen.getByTestId('message-bubble');
    expect(b.className).toContain('justify-end');
    expect(b.getAttribute('data-role')).toBe('user');
  });

  it('has no a11y violations', async () => {
    setup({ id: 'm1', role: 'user', content: 'hi' });
    await expectNoA11yViolations(document.body);
  });

  it('renders assistant role bubbles left-aligned', () => {
    setup({ id: 'm1', role: 'assistant', content: 'hello' });
    expect(screen.getByTestId('message-bubble').className).toContain(
      'justify-start',
    );
  });

  it('renders the bubble text content', () => {
    setup({ id: 'm1', role: 'assistant', content: 'visible body' });
    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent(
      'visible body',
    );
  });

  it('第一个字还没到,气泡里只有那个点', () => {
    // 这一刻读者除了「等着」什么都没有:回复还没长出来,按钮已经变成停止,
    // 两样都只看得见。定稿定的是一个点呼吸(user 2026-08-12 定、08-19 复核
    // 维持),不是一个方块在闪 —— 方块是打字游标,它要有字才说得通。
    setup({ id: 'm1', role: 'assistant', content: '', streaming: true });

    expect(screen.getByTestId('chat-waiting-dot')).toBeInTheDocument();
  });

  it('字来了那个点不走,跟在最后一个字后面', () => {
    // user 2026-08-20 定:「圆点不能消失,也不能换成竖杠,那个圆点就一直是在
    // 最后一个字后面」。此前是两个标记二选一 —— 没字画点、有字换成一个闪烁
    // 的竖条,于是那个点在读者最需要「它还在说」这个信号的整段时间里反而不
    // 在。现在只有一个标记,它从这一轮开始跟到结束。
    const { container } = setup({ id: 'm1', role: 'assistant', content: '好', streaming: true });

    const dot = screen.getByTestId('chat-waiting-dot');
    expect(dot).toBeInTheDocument();
    // 紧跟在最后一个字后面,不是气泡里别的什么位置。原来这一条断言的是
    // 「点是正文容器的最后一个元素子节点」—— 那时正文是一个字符串,两种说法
    // 指同一处。正文现在是一棵元素树,最后一个字在某个块里面,所以断言改成
    // 直接量它:点的前一个节点就是那个字。
    expect(dot.previousSibling?.textContent).toContain('好');
    const said = container.querySelector('[data-testid="message-bubble-content"]');
    expect(said?.textContent).toContain('好');
  });

  it('这一轮结束,那个点跟着走', () => {
    setup({ id: 'm1', role: 'assistant', content: '好', streaming: false });

    expect(screen.queryByTestId('chat-waiting-dot')).not.toBeInTheDocument();
  });

  it('renders ThinkingFold when thinking is present', () => {
    setup({
      id: 'm1',
      role: 'assistant',
      content: 'x',
      thinking: 'step 1',
    });
    expect(screen.getByTestId('thinking-fold')).toBeInTheDocument();
  });

  it('renders tool call cards', () => {
    setup({
      id: 'm1',
      role: 'assistant',
      content: 'x',
      toolCalls: [
        { id: 't1', name: 'web_search', args: {}, status: 'success' },
      ],
    });
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
  });

  it('says so when the turn was stopped before it finished', () => {
    // The backend goes to the trouble of storing this mark (batch 3, item 33)
    // so the reader can tell a cut-off answer from a complete one. Carrying it
    // to the component and not drawing it wastes the whole chain.
    render(
      <MessageBubble
        message={{ id: 'm1', role: 'assistant', content: 'half a sen', interrupted: true }}
      />,
    );

    expect(screen.getByTestId('message-bubble-interrupted')).toBeInTheDocument();
  });

  it('does not say that about a reply that finished', () => {
    render(<MessageBubble message={{ id: 'm2', role: 'assistant', content: 'all of it' }} />);

    expect(screen.queryByTestId('message-bubble-interrupted')).toBeNull();
  });

  it('shows the failure in the reader\'s own language, not the server\'s', () => {
    // Acceptance item 26. What the server sends on this path is a hardcoded
    // English sentence, so the panel says it itself.
    render(
      <MessageBubble message={{ id: 'm3', role: 'assistant', content: '', failed: true }} />,
    );

    // Found by its own handle rather than by role: the mark is stated, not
    // announced, for the reason the test below pins.
    const mark = screen.getByTestId('message-bubble-error');
    expect(mark.textContent).toBe('This reply could not be finished. Try sending it again.');
  });

  it('does not announce a failure that came back with the history', () => {
    // Failure is stored, so it comes back with every reload. An assertive
    // region on all of them would read out every past failure in the
    // conversation — one after another — the moment the panel opens. What
    // tells them apart is the mark below: this one is missing it, so this
    // failure is being read about, not being lived through.
    render(
      <MessageBubble
        message={{ id: 'm1', role: 'assistant', content: 'Half a sen', failed: true }}
      />,
    );
    expect(screen.getByTestId('message-bubble-error').getAttribute('role')).toBeNull();
  });

  it('announces a failure that just happened, while the reader is waiting', () => {
    // Acceptance item 26. Someone who sent a message and is waiting for the
    // answer has no other way to learn the turn is over: the reply simply
    // stops growing and the stop button turns back into send, both of which
    // are only visible. Using a screen reader, they wait for something that
    // is never coming.
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          content: 'Half a sen',
          failed: true,
          failedJustNow: true,
        }}
      />,
    );
    expect(screen.getByTestId('message-bubble-error').getAttribute('role')).toBe('alert');
  });
});

describe('MessageBubble — markdown rendering', () => {
  it('renders assistant prose through the markdown renderer', () => {
    setup({ id: 'm1', role: 'assistant', content: 'a line with **bold** in it' });

    const md = screen.getByTestId('markdown-body');
    expect(md.querySelector('strong')).toHaveTextContent('bold');
  });

  it('leaves what the reader typed as plain text (R13)', () => {
    // Someone typing **text** into the composer means those characters.
    setup({ id: 'm1', role: 'user', content: 'a line with **bold** in it' });

    expect(screen.queryByTestId('markdown-body')).toBeNull();
    expect(screen.getByTestId('message-bubble')).toHaveTextContent('**bold**');
    expect(screen.getByTestId('message-bubble').querySelector('strong')).toBeNull();
  });

  it('keeps the dot out of the rendering once prose has arrived', () => {
    setup({ id: 'm1', role: 'assistant', content: 'still writing', streaming: true });

    const dot = screen.getByTestId('chat-waiting-dot');
    expect(dot.closest('[data-testid="markdown-body"]')).toBeNull();
  });

  it('shows the dot alone before the first character', () => {
    setup({ id: 'm1', role: 'assistant', content: '', streaming: true });

    expect(screen.getByTestId('chat-waiting-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-body')).toBeNull();
  });
});

describe('MessageBubble — the waiting mark is the turn\'s own state (R7)', () => {
  /**
   * Renders one streaming assistant turn.
   * @param content - What has arrived so far.
   * @returns The container.
   */
  const streamingTurn = (content: string): HTMLElement =>
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          content,
          streaming: true,
        }}
      />,
    ).container;

  it('sits after the whole rendered reply, whatever the reply is made of', () => {
    // The mark says the answer is still coming. It is not part of the answer,
    // so it goes after the rendering rather than inside it — a code fence, a
    // table, a footnote section are all just "the reply" to it.
    for (const content of [
      'hello wor',
      '```js\nconst a = 1;',
      '```js\nreturn\n  ',
      '```js\n   ',
      'A claim[^1].\n\n[^1]: the note being writt',
      '| a | b |\n| - | - |\n| 1 | 2',
    ]) {
      const container = streamingTurn(content);
      const mark = container.querySelector('[data-testid="chat-waiting-dot"]');
      const body = container.querySelector('[data-testid="markdown-body"]');

      expect(mark, `${content}: the mark is drawn`).not.toBeNull();
      expect(body, `${content}: the reply is rendered`).not.toBeNull();
      expect(
        body?.contains(mark ?? null),
        `${content}: the mark is outside the rendering`,
      ).toBe(false);
      expect(
        body?.nextElementSibling === mark || body?.parentElement?.lastElementChild === mark,
        `${content}: the mark follows the rendering`,
      ).toBe(true);
      cleanup();
    }
  });
});
