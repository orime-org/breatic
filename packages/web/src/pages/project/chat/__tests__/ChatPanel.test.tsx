// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn() },
}));

import { chatApi } from '@web/data/api/chat';
import { StreamUnreachableError } from '@web/data/stream/sse';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { useChatStore } from '@web/stores';
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
      <ChatPanel {...props} />
    </QueryClientProvider>,
  );
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
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.getState().reset();
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
    // The composer is off until there is a conversation to write to.
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled(),
    );
    await user.type(screen.getByTestId('chat-composer-textarea'), 'Hi!');
    expect(useChatStore.getState().composerDraft).toBe('Hi!');
  });

  it('clicking Send sends the trimmed draft and clears it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    useChatStore.getState().setComposerDraft('  test  ');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() =>
      expect(chatApi.streamMessage).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'test', conversationId: 'c1' }),
        expect.anything(),
      ),
    );
    expect(useChatStore.getState().composerDraft).toBe('');
  });

  it('clears the composer as soon as the message is sent, not when the reply ends', async () => {
    const user = userEvent.setup();
    // Hold the stream open, the way a real turn does for as long as it runs.
    let endTurn = (): void => {};
    vi.mocked(chatApi.streamMessage).mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          endTurn = resolve;
        }),
    );
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    useChatStore.getState().setComposerDraft('first question');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    // The words are on screen as a sent message. Leaving them in the box too
    // reads as a send that did not take, and anything typed while waiting is
    // wiped the moment the reply finishes.
    expect(useChatStore.getState().composerDraft).toBe('');
    endTurn();
  });

  it('does not overwrite what was typed while a failed send was in flight', async () => {
    const user = userEvent.setup();
    let failTurn = (): void => {};
    vi.mocked(chatApi.streamMessage).mockImplementation(
      async () =>
        new Promise<void>((_resolve, reject) => {
          failTurn = () => reject(new StreamUnreachableError(new Error('offline')));
        }),
    );
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    useChatStore.getState().setComposerDraft('shorten this for me');
    await user.click(screen.getByTestId('chat-composer-send'));
    await waitFor(() => expect(useChatStore.getState().composerDraft).toBe(''));

    // The composer is live for the whole turn, so carrying on typing is the
    // ordinary thing to do.
    useChatStore.getState().setComposerDraft('and three titles too');

    await act(async () => {
      failTurn();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Handing back the words that were not sent must not take away the words
    // that were typed since. They are gone with no message, no undo, and no
    // sign of where they went.
    expect(useChatStore.getState().composerDraft).toBe('and three titles too');
  });

  it('does not let anything be typed before the chat is open', async () => {
    // openChat never answers, which is the state every panel starts in.
    vi.mocked(chatApi.openChat).mockImplementation(() => new Promise(() => {}));
    renderPanel();

    // Pressing enter here used to drop the keystroke with no request, no
    // error and no bubble — the user cannot tell it was not sent.
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).toBeDisabled(),
    );
  });

  it('keeps what the user typed when the chat could not be opened', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    renderPanel();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    useChatStore.getState().setComposerDraft('please do not eat this');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Clearing the draft on a send that never happened is how the words were
    // lost: nothing was sent, and there was nothing left to send again.
    expect(useChatStore.getState().composerDraft).toBe('please do not eat this');
  });

  it('hands the words back when the message could not be sent', async () => {
    const user = userEvent.setup();
    vi.mocked(chatApi.streamMessage).mockRejectedValue(new Error('never left'));
    renderPanel();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-textarea')).not.toBeDisabled(),
    );

    useChatStore.getState().setComposerDraft('is anyone there');
    await user.click(screen.getByTestId('chat-composer-send'));

    // Nothing was stored, and nothing of the attempt is left on screen — so
    // if the words are not handed back they are simply gone, and the user has
    // to type the whole thing again.
    await waitFor(() =>
      expect(useChatStore.getState().composerDraft).toBe('is anyone there'),
    );
  });
});
