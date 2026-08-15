// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn(), messagesBefore: vi.fn() },
}));

import { SSE_EVENT_NAMES } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

import { chatApi } from '@web/data/api/chat';
import { StreamRefusedError, StreamUnreachableError } from '@web/data/stream/sse';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { useChatStore } from '@web/stores';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';

/** The conversation every case in this file is opened into. */
const CONV = 'c1';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

/**
 * Render the panel with a query client of its own.
 * @param props - Props for the panel under test
 * @returns The render result
 */
function renderPanel(props: { projectId: string } = { projectId: 'p1' }): ReturnType<
  typeof render
> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel historyOpen={false} onHistoryOpenChange={() => undefined} {...props} />
    </QueryClientProvider>,
  );
}

/**
 * Make the stream fail the way the real one does.
 *
 * `sseStream` catches everything, hands it to `onError` and then resolves
 * (sse.ts:218-222) — it never rejects. A mock that rejects is modelling
 * something the transport does not do, and a panel tested against it is
 * tested against a shape it will never see.
 * @param err - What went wrong, already classified the way sse.ts does it
 */
function streamFailsWith(err: unknown): void {
  vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, handlers) => {
    handlers.onError?.(err);
  });
}

/** The stream handlers the panel's last send installed. */
let handlers: {
  onEvent: (e: SSEEventEnvelope) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
};

/**
 * Hold the stream open, the way a real turn does for as long as it runs.
 *
 * Nothing is answered until a case says so, which is what makes the wait
 * between pressing send and the server's first word observable at all.
 */
function streamStaysOpen(): void {
  vi.mocked(chatApi.streamMessage).mockImplementation((_input, h) => {
    handlers = h;
    return new Promise<void>(() => {});
  });
}

/**
 * Say the turn has begun, which is the server's first word on every turn.
 * @param texts - What the server says the conversation now holds, in order
 */
function turnStarts(texts: string[]): void {
  handlers.onEvent({
    event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
    data: {
      messages: texts.map((text, i) => ({
        id: `srv${i}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        content: text,
        ts: '2026-08-14T00:00:00Z',
        turnIndex: 10 + i,
      })),
      hasMore: false,
    },
  } as unknown as SSEEventEnvelope);
}

/**
 * Answer the open call with a conversation carrying the given messages.
 * @param texts - What has been said in it, in order
 */
function chatOpensWith(texts: string[]): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: {
      conversation: { id: 'c1' },
      messages: texts.map((text, i) => ({
        id: `m${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text }],
        content: text,
        ts: '2026-08-11T00:00:00Z',
        turnIndex: 1,
      })),
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('ChatPanel', () => {
  beforeEach(() => {
    // Reset, not clear: an unconsumed `mockImplementationOnce` left by an
    // earlier case survives `clearAllMocks` and fires in the next one.
    vi.resetAllMocks();
    useChatStore.getState().reset();
    // The conversation runtime is a module singleton, so it carries whatever
    // the last case left in it into the next one.
    _resetForTests();
    chatOpensWith([]);
    vi.mocked(chatApi.streamMessage).mockResolvedValue(undefined);
  });

  it('has no a11y violations', async () => {
    const { container } = renderPanel();
    await expectNoA11yViolations(container);
  });

  it('renders the panel landmark with the projectId attribute', () => {
    renderPanel();
    expect(screen.getByTestId('chat-panel').getAttribute('data-project-id')).toBe('p1');
  });

  it('renders one bubble per message the server sent back', async () => {
    chatOpensWith(['Plan a launch', 'Sure, here is the plan…']);
    renderPanel();

    // Acceptance item 12: what the endpoint returned is what is on screen,
    // one for one.
    await waitFor(() => expect(screen.getAllByTestId('message-bubble')).toHaveLength(2));
  });

  it('typing in the composer writes to the chat store draft', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await user.type(screen.getByTestId('chat-composer-textarea'), 'Hi!');
    expect(conversationRuntime.draftOf('p1', CONV)).toBe('Hi!');
  });

  it('sends the trimmed draft, and empties the box when the server has it', async () => {
    const user = userEvent.setup();
    streamStaysOpen();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, '  test  ');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() =>
      expect(chatApi.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'test', conversationId: 'c1' }),
        expect.anything(),
      ),
    );
    // Still in the box, because so far nothing has confirmed it went anywhere.
    // Emptying it now is a promise the browser is in no position to make: the
    // words would be gone from the only place they exist, with nothing on
    // screen to show for them.
    expect(conversationRuntime.draftOf('p1', CONV)).toBe('  test  ');
    // And nothing to press: not send again, and not stop.
    expect(screen.getByTestId('chat-composer-sending')).toBeInTheDocument();

    act(() => {
      turnStarts(['test']);
    });

    // The server has the message and has handed the conversation back. Now the
    // box is empty, and the stop button is the one thing worth pressing.
    await waitFor(() => expect(conversationRuntime.draftOf('p1', CONV)).toBe(''));
    expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument();
  });

  it('takes nothing into the box while the server has not answered', async () => {
    const user = userEvent.setup();
    streamStaysOpen();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, 'first question');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    // The box shows what was sent and accepts nothing more, so there is never
    // a moment where it holds one sentence of ours and another of theirs.
    const box = screen.getByTestId('chat-composer-textarea') as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    await user.type(box, ' and one more thing');
    expect(conversationRuntime.draftOf('p1', CONV)).toBe('first question');

    act(() => {
      turnStarts(['first question']);
    });

    // And then it is emptied, with no rule applied to the text: only one
    // thing could have been in it.
    await waitFor(() => expect(conversationRuntime.draftOf('p1', CONV)).toBe(''));
    expect(screen.getByTestId('chat-composer-textarea')).toHaveProperty('readOnly', false);
  });

  it('says so on the composer when the message never went out', async () => {
    const user = userEvent.setup();
    streamFailsWith(new StreamUnreachableError(new Error('offline')));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, 'shorten this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // No answer came back, so there is nothing to quote and nothing to add.
    // Two words: what to do about it is the reader's own business.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );
  });

  it('says it again when it fails again, in the same words', async () => {
    const user = userEvent.setup();
    streamFailsWith(new StreamUnreachableError(new Error('offline')));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, 'is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));
    const firstLine = await screen.findByTestId('chat-notice');

    // Straight away, while the first line is still up -- which is when a
    // reader presses again, not four seconds later.
    await user.click(screen.getByTestId('chat-composer-send'));

    // Same words, so a line left in place is a line React does not touch: the
    // DOM would not move and a screen reader would announce nothing. The
    // second failure has to be its own line.
    await waitFor(() => expect(screen.getByTestId('chat-notice')).not.toBe(firstLine));
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('says what the server said when it refused', async () => {
    const user = userEvent.setup();
    streamFailsWith(new StreamRefusedError(403, 'You do not have access to this project', true));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, 'let me in');
    await user.click(screen.getByTestId('chat-composer-send'));

    // The server went to the trouble of saying why, in the reader's language.
    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent(
        'You do not have access to this project',
      ),
    );
  });

  it('has one place to say things, not two', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    // A chat that would not open used to have its own red bar at the top of
    // the panel. Two places that say things is one too many: the reader has
    // to learn where to look, and the two can disagree.
    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-open-failed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('says one thing about a chat that would not open, and offers nothing', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );
    // No button, no instruction. Reloading or trying again is the reader's own
    // business, and telling them to do it adds nothing they cannot see.
    expect(screen.queryByTestId('chat-notice-action')).not.toBeInTheDocument();
  });

  it('lets the reader type and send while the chat is still opening', async () => {
    // openChat never answers, which is the state every panel starts in.
    vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
    renderPanel();

    // Turning the box off is how a keystroke used to be dropped in silence:
    // the fix for that was to stop the reader typing, which is the wrong end
    // of it. Sending is what opens a conversation when there is not one, so
    // there is nothing here to protect them from.
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled();
  });

  it('disables nothing of its own when the chat could not be opened', async () => {
    // The panel does not answer for this: what covers the column when its
    // conversations cannot be read is the column's own scrim, one layer up,
    // and it covers the header too. So nothing here is turned off -- there
    // would be no way to reach it anyway.
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    streamStaysOpen();
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('chat-notice')).toHaveTextContent('Network error'),
    );

    expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled();
  });

  it('keeps what the user typed when the chat could not be opened', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    conversationRuntime.setDraft('p1', CONV, 'please do not eat this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Clearing the draft on a send that never happened is how the words were
    // lost: nothing was sent, and there was nothing left to send again.
    expect(conversationRuntime.draftOf('p1', CONV)).toBe('please do not eat this');
  });

  it('leaves the words where they are when the message never went out', async () => {
    const user = userEvent.setup();
    streamFailsWith(new StreamUnreachableError(new Error('never left')));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled(),
    );

    conversationRuntime.setDraft('p1', CONV, 'is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Nothing was stored and nothing of the attempt is on screen, so the box
    // is the only place these words exist. They are still in it because the
    // one thing that empties it never happened -- there is no handing back to
    // get wrong, and nothing to get wrong it on top of.
    await waitFor(() =>
      expect(screen.queryByTestId('chat-composer-sending')).toBeNull(),
    );
    expect(conversationRuntime.draftOf('p1', CONV)).toBe('is anyone there');
  });
});

describe('a conversation longer than one page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useChatStore.getState().reset();
    _resetForTests();
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c1' }],
      current: {
        conversation: { id: 'c1' },
        messages: [
          {
            id: 'm1',
            role: 'user',
            parts: [{ type: 'text', text: 'the oldest thing on screen' }],
            content: 'the oldest thing on screen',
            ts: '2026-08-13T00:00:00Z',
            turnIndex: 12,
          },
        ],
        hasMore: true,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  });

  it('stops saying it on its own, without waiting to be cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    streamFailsWith(new StreamUnreachableError(new Error('offline')));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('p1', CONV, 'shorten this');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(screen.getByTestId('chat-notice')).toBeInTheDocument());

    // It belongs to the moment it happened in, and that moment passes. A line
    // that waited to be cleared would still be standing there when the next
    // thing went wrong, saying the wrong thing about it.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId('chat-notice')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('offers to load what came before, and stops offering once it has', async () => {
    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'from further back' }],
          content: 'from further back',
          ts: '2026-08-12T00:00:00Z',
          turnIndex: 4,
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);

    renderPanel();
    // Without this the conversation simply begins in the middle, with nothing
    // on screen saying that what came before it is still there.
    const button = await screen.findByTestId('chat-load-earlier');

    await userEvent.click(button);

    await screen.findByText('from further back');
    // Asked from where the loaded history reaches back to.
    expect(chatApi.messagesBefore).toHaveBeenCalledWith('c1', 12, expect.any(AbortSignal));
    // Nothing older left, so the offer goes away rather than sitting there
    // fetching nothing.
    await waitFor(() => expect(screen.queryByTestId('chat-load-earlier')).toBeNull());
  });
});
