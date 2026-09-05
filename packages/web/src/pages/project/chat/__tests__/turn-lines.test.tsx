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

import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  it('offers a retry on a turn that failed', async () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: '', failed: true }}
        onRetry={onRetry}
      />,
    );

    await userEvent.click(screen.getByTestId('turn-retry'));
    expect(onRetry).toHaveBeenCalledWith('m');
  });

  it('offers a retry on a turn that said nothing at all', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: '' }} onRetry={vi.fn()} />);

    expect(screen.getByTestId('message-bubble-empty')).toBeInTheDocument();
    expect(screen.getByTestId('turn-retry')).toBeInTheDocument();
  });

  it('offers a way to carry on, not to start over, on a turn cut off at the ceiling', async () => {
    const onContinue = vi.fn();
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'half a sen', truncated: true }}
        onContinue={onContinue}
      />,
    );

    expect(screen.queryByTestId('turn-retry')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('turn-continue'));
    expect(onContinue).toHaveBeenCalledWith('m');
  });

  it('says a turn is waiting on the reader, and offers no retry for it', () => {
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: '', blocked: true }} onRetry={vi.fn()} />,
    );

    expect(screen.getByTestId('message-bubble-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-bubble-empty')).not.toBeInTheDocument();
  });

  it('keeps what a stopped turn managed to say, and does not call it a fault', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'as far as it got', interrupted: true }}
      />,
    );

    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent('as far as it got');
    expect(screen.getByTestId('message-bubble-interrupted')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-retry')).not.toBeInTheDocument();
  });

  it('says nothing about the ending while the turn is still running', () => {
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: '', streaming: true }} onRetry={vi.fn()} />,
    );

    expect(screen.queryByTestId('message-bubble-empty')).not.toBeInTheDocument();
  });
});

describe('what a finished reply offers', () => {
  it('puts copy and regenerate under an answer', async () => {
    const onRetry = vi.fn();
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'the answer' }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByTestId('turn-copy')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('turn-regenerate'));
    expect(onRetry).toHaveBeenCalledWith('m');
  });

  it('offers none of that on a reply still arriving', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'half', streaming: true }}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('turn-copy')).not.toBeInTheDocument();
  });

  it('offers copy on what the reader wrote, and nothing else', () => {
    render(<MessageBubble message={{ id: 'm', role: 'user', content: 'my question' }} onRetry={vi.fn()} />);

    expect(screen.getByTestId('turn-copy')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-regenerate')).not.toBeInTheDocument();
  });
});
