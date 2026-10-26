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
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
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

  it('says what a picture search is looking for, in its own words', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          // `search_images` declares a sentence of its own, distinct from
          // web_search's: a reader told "searching the web" while pictures are
          // being fetched is told about the wrong tool.
          toolCalls: [
            running('search_images', { query: 'cyberpunk city' }, 'chat.tool.searchingImages'),
          ],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('cyberpunk city');
  });

  it('names a tool that declares no sentence, and leaves the name in English', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          // `ask_user` is one: it stops the turn rather than running, so there
          // is nothing to say is in progress.
          toolCalls: [running('ask_user')],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('ask_user');
  });

  it('shows one line for several tools at once, naming the newest', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: '',
          streaming: true,
          toolCalls: [running('web_search', { query: 'a' }), running('search_images')],
        }}
      />,
    );

    expect(screen.getAllByTestId('tool-run-line')).toHaveLength(1);
    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('search_images');
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
            running('search_images'),
          ],
        }}
      />,
    );

    expect(screen.getByTestId('tool-run-line')).toHaveTextContent('search_images');
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

describe('the line a failed tool step leaves (inner#1620)', () => {
  /**
   * A reply read the way the panel reads it.
   * @param parts - Its parts.
   * @param streaming - Whether it is still arriving.
   * @returns The rendered bubble.
   */
  const drawn = (parts: unknown[], streaming = false): ReturnType<typeof render> =>
    render(
      <MessageBubble message={toChatMessage({ id: 'm', role: 'assistant', parts } as never, { streaming })} />,
    );

  /**
   * A search that ended in an error.
   * @param errorText - What the wire carried.
   * @returns The part.
   */
  const failedSearch = (errorText = 'chat.tool.failure.busy'): unknown => ({
    type: 'tool-web_search',
    toolCallId: 's1',
    state: 'output-error',
    input: { query: 'poster' },
    errorText,
  });

  it('says which step did not finish and why, where it happened', () => {
    drawn([{ type: 'text', text: 'Let me look.' }, failedSearch(), { type: 'text', text: 'Carrying on.' }]);

    expect(screen.getByTestId('message-bubble-tool-failed').textContent).toBe(
      'Search for “poster” didn\'t finish: the service ran into an error, try again later',
    );
  });

  it('draws it the moment the step fails, while the reply is still arriving', () => {
    drawn([{ type: 'text', text: 'Let me look.' }, failedSearch()], true);

    expect(screen.getByTestId('message-bubble-tool-failed')).toBeInTheDocument();
  });

  it('draws nothing for a step the reader stopped, which the turn already says', () => {
    drawn([
      { type: 'tool-web_search', toolCallId: 's1', state: 'input-available', input: { query: 'q' } },
      { type: 'data-interrupted', data: {} },
    ]);

    expect(screen.queryByTestId('message-bubble-tool-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-interrupted')).toBeInTheDocument();
  });

  it('draws nothing for a call turned away to steer the model, and still draws a real failure', () => {
    drawn([
      { type: 'tool-understand_media', toolCallId: 'u1', state: 'output-error', input: {}, errorText: 'turned_away' },
      failedSearch(),
    ]);

    expect(screen.getAllByTestId('message-bubble-tool-failed')).toHaveLength(1);
  });
});

describe('how a stored turn reads when the conversation is reopened', () => {
  // The shapes below are what `GET /chat/conversations/:id` answers with
  // (`toUiMessages`), checked against a real store in the server's
  // `turn-message-shape.integration.test.ts`.

  it('says a turn that failed before its first word failed', () => {
    render(
      <MessageBubble
        message={toChatMessage({ id: 'm', role: 'assistant', parts: [{ type: 'data-failed', data: {} }] })}
      />,
    );

    const line = screen.getByTestId('message-bubble-error');
    expect(line).toHaveClass('text-status-error-foreground');
    // Wrapped so its last line is never a single word.
    expect(screen.getByText('This reply could not be finished. Try sending it again.')).toHaveClass('text-pretty');
  });

  it('says a turn that ended too long to finish so, and not that it should be sent again (inner#1567)', () => {
    render(
      <MessageBubble
        message={toChatMessage({ id: 'm', role: 'assistant', parts: [{ type: 'data-failed', data: { reason: 'too_long' } }] })}
      />,
    );

    const line = screen.getByTestId('message-bubble-error');
    expect(line).toHaveTextContent('This turn had too much to process and could not finish. Try a narrower request.');
    expect(line).not.toHaveTextContent('Try sending it again');
  });

  it('says a turn that produced nothing produced nothing', () => {
    render(<MessageBubble message={toChatMessage({ id: 'm', role: 'assistant', parts: [] })} />);

    expect(screen.getByTestId('message-bubble-empty')).toHaveTextContent('No reply this turn');
  });

  it('says a step failed in a turn that carried on', () => {
    render(
      <MessageBubble
        message={toChatMessage({
          id: 'm',
          role: 'assistant',
          parts: [
            {
              type: 'tool-always_fails',
              toolCallId: 'tc-fail',
              input: {},
              state: 'output-error',
              errorText: 'chat.tool.failure.generic',
              failureKind: 'tool_failed',
            } as never,
            { type: 'text', text: 'Carrying on without it.' },
          ],
        })}
      />,
    );

    // Stored before causes were recorded: the step is named, the cause is not.
    expect(screen.getByTestId('message-bubble-tool-failed').textContent).toBe('Calling always_fails didn\'t finish');
    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent('Carrying on without it.');
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
