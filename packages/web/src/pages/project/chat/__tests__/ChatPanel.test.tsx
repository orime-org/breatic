// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn() },
}));

import { chatApi } from '@web/data/api/chat';
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
});
