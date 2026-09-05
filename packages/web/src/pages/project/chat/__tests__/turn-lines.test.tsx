// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two lines a turn puts under itself: what it is doing, and how it ended.
 *
 * They never coexist. While a turn runs, one line says what tool is running
 * and it is replaced as tools come and go; once the turn ends that line is
 * gone and leaves nothing behind, not even on a reload -- what a reader wants
 * afterwards is the answer, not a log of how it was assembled.
 *
 * How it ended is drawn on the message it belongs to. Five endings, and only
 * three of them are faults: a turn waiting on an answer gets a neutral line
 * and no retry, and a turn cut off at the ceiling is offered a way to carry
 * on rather than to start over.
 */

import { describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ToolCall } from '@web/pages/project/chat/types';

/**
 * A tool call in flight.
 * @param name - Which tool.
 * @param args - What it was called with.
 * @returns The call.
 */
const running = (
  name: string,
  args: Record<string, unknown> = {},
  runningLine?: string,
): ToolCall => ({
  id: `c-${name}`,
  name,
  args,
  status: 'pending',
  ...(runningLine === undefined ? {} : { runningLine }),
});

afterEach(cleanup);

describe('the line that says what a turn is doing', () => {
  it('is a bare dot before anything has happened', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '', streaming: true }} />);

    expect(screen.getByTestId('chat-waiting-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('tool-run-line')).not.toBeInTheDocument();
  });

  it('says what a search is looking for, with the query in the sentence', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          // The key rides on the call, the way `web_search` declares it.
          toolCalls: [
            running('web_search', { query: '哥特洛丽塔 参考图' }, 'chat.tool.searching'),
          ],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('哥特洛丽塔 参考图');
  });

  it('names a tool that declares no sentence, and leaves the name in English', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          toolCalls: [running('propose_canvas_action')],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('propose_canvas_action');
  });

  it('shows one line for several tools at once, naming the newest', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          toolCalls: [running('web_search', { query: 'a' }), running('show_search_results')],
        }}
      />,
    );

    expect(screen.getAllByTestId('tool-run-line')).toHaveLength(1);
    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('show_search_results');
  });

  it('keeps the line while one of two calls is still running', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          toolCalls: [
            { ...running('web_search', { query: 'a' }), status: 'success', result: {} },
            running('show_search_results'),
          ],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('show_search_results');
  });

  it('leaves nothing behind once the turn has ended', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'the answer',
          toolCalls: [{ ...running('web_search', { query: 'a' }), status: 'success', result: {} }],
        }}
      />,
    );

    expect(screen.queryByTestId('tool-run-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-card')).not.toBeInTheDocument();
  });
});

describe('how a turn ended', () => {
  it('says a turn failed, and leaves the next move to the reader', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '', failed: true }} />);

    expect(screen.getByTestId('message-bubble-error')).toBeInTheDocument();
    // Nothing to press. Asking again is typing again, which the composer is
    // already there for.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says a turn produced nothing', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '' }} />);

    expect(screen.getByTestId('message-bubble-empty')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says a turn was cut off at the length limit', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'half a sen', truncated: true }}
      />,
    );

    expect(screen.getByTestId('message-bubble-truncated')).toBeInTheDocument();
  });

  it('says a turn is waiting on the reader', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '', blocked: true }} />);

    expect(screen.getByTestId('message-bubble-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('message-bubble-empty')).not.toBeInTheDocument();
  });

  it('keeps what a stopped turn managed to say', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'as far as it got', interrupted: true }}
      />,
    );

    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent('as far as it got');
    expect(screen.getByTestId('message-bubble-interrupted')).toBeInTheDocument();
  });

  it('says nothing about the ending while the turn is still running', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '', streaming: true }} />);

    expect(screen.queryByTestId('message-bubble-empty')).not.toBeInTheDocument();
  });

  it('draws each ending as an icon and a line, with nothing around it', () => {
    // A bordered, filled bar reads as a thing in its own right sitting under
    // the reply. What it is is a note about the reply, so it sits on the same
    // surface as the words above it.
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '', failed: true }} />);

    const line = screen.getByTestId('message-bubble-error');
    expect(line.className).not.toMatch(/\bborder\b|\bbg-/);
    expect(line.querySelector('svg')).not.toBeNull();
  });
});

describe('what a finished reply offers', () => {
  it('offers copy under an answer', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: 'the answer' }} />);

    expect(screen.getByTestId('turn-copy')).toBeInTheDocument();
  });

  it('offers none of that on a reply still arriving', () => {
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'half', streaming: true }} />,
    );

    expect(screen.queryByTestId('turn-copy')).not.toBeInTheDocument();
  });

  it('offers copy on what the reader wrote too', () => {
    render(<MessageBubble message={{ id: 'm', role: 'user', content: 'my question' }} />);

    expect(screen.getByTestId('turn-copy')).toBeInTheDocument();
  });
});
