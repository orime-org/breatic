// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The agent column: its header, its chat, and the scrim over both.
 *
 * What is pinned here is the part neither the header nor the panel can answer
 * for on its own -- what the column shows when its conversations cannot be
 * read, and what the header says about the conversation on screen.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(() => new Promise<void>(() => {})),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { chatApi } from '@web/data/api/chat';
import { AgentColumn } from '@web/pages/project/chrome/AgentColumn';
import { _resetForTests } from '@web/stores/conversation-runtime';

const PROJECT = 'p-1';

/**
 * Render the column under a tooltip provider, the way the app does.
 *
 * The app has exactly one, on `App.tsx`; a test that renders a subtree has to
 * stand in for it. This is the one place a second provider is allowed.
 * @returns The render result.
 */
function renderColumn(): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <AgentColumn projectId={PROJECT} />
    </TooltipProvider>,
  );
}

/**
 * Answer the open call with a list and the one that is current.
 * @param conversations - The list as the server would give it.
 */
function opensWith(conversations: Array<{ id: string; title: string | null }>): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations,
    current: {
      conversation: conversations[0],
      messages: [],
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('when the conversations cannot be read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('covers the column, header included', async () => {
    // With no list, the entries in the header have nothing to act on. Leaving
    // them reachable would be putting up buttons whose only outcome is to
    // fail again.
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();

    const scrim = await screen.findByTestId('chat-unreachable');
    const column = screen.getByTestId('agent-column');
    expect(column).toContainElement(scrim);
    expect(within(column).getByTestId('agent-col-header')).toBeInTheDocument();
  });

  it('gives the reader one thing to do about it', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();
    await screen.findByTestId('chat-unreachable');
    vi.mocked(chatApi.openChat).mockClear();

    await userEvent.click(screen.getByTestId('chat-reload'));

    expect(chatApi.openChat).toHaveBeenCalled();
  });

  it('says what went wrong in the language the reader is reading', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    renderColumn();

    const scrim = await screen.findByTestId('chat-unreachable');
    // Not the English the server would have sent: the placeholder and the
    // reason are both chosen here, where the language is known.
    expect(scrim).toHaveTextContent('Network error');
  });
});

describe('when they can', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('shows nothing over the column', async () => {
    opensWith([{ id: 'c-1', title: 'Storyboard notes' }]);
    renderColumn();

    await waitFor(() => expect(screen.getByTestId('agent-col-header')).toBeInTheDocument());
    expect(screen.queryByTestId('chat-unreachable')).toBeNull();
  });

  it('names the conversation on screen in the header', async () => {
    opensWith([{ id: 'c-1', title: 'Storyboard notes' }]);
    renderColumn();

    await waitFor(() =>
      expect(screen.getByTestId('agent-col-header')).toHaveTextContent('Storyboard notes'),
    );
  });

  it('stands in for one that has no name yet', async () => {
    opensWith([{ id: 'c-1', title: null }]);
    renderColumn();

    await waitFor(() =>
      expect(screen.getByTestId('agent-col-header')).toHaveTextContent(
        'Untitled conversation',
      ),
    );
  });

  it('counts the conversations, not the messages', async () => {
    // The chip sits beside the button that opens the list, and what is behind
    // that button is conversations.
    opensWith([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: null },
    ]);
    renderColumn();

    await waitFor(() =>
      expect(screen.getByTestId('conversation-count-chip')).toHaveTextContent('3'),
    );
  });
});
