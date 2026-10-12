// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat panel tells the Agent about the reader's Spaces (inner#1413): the
 * chip names the Space whose tab is active, pressing it turns that Space off
 * and on, and each message carries the project's Spaces with the open one
 * only while it is on.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(),
    openChat: vi.fn(),
    messagesBefore: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listConversations: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
  },
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { chatApi } from '@web/data/api/chat';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { useUIStore } from '@web/stores/ui';
import { stubChatWire } from '@web/test-utils/chat-wire';
import type { WatchedWire } from '@web/test-utils/chat-wire';

const cast: ProjectSpace = { id: 's1', name: 'Cast', type: 'canvas', createdAt: 1 };
const storyboard: ProjectSpace = { id: 's2', name: 'Storyboard', type: 'document', createdAt: 2 };
const SPACES = [cast, storyboard];

let wire: WatchedWire;

/**
 * Render the panel with an open Space.
 * @param activeSpace - The Space whose tab is active.
 * @returns The rerender function.
 */
function renderPanel(activeSpace: ProjectSpace | undefined): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ChatPanel
          projectId='p1'
          historyOpen={false}
          onHistoryOpenChange={() => undefined}
          activeSpace={activeSpace}
          spaces={SPACES}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetForTests();
  evictAllChatSessions();
  useUIStore.setState(useUIStore.getInitialState());
  window.localStorage.clear();
  wire = stubChatWire();
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: { conversation: { id: 'c1' }, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  vi.mocked(chatApi.streamConfig).mockResolvedValue({
    heartbeatIntervalMs: 5000,
    attachmentMaxChars: 200_000,
    attachmentMaxItems: 10,
    currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the open Space in the chat panel', () => {
  it('names the Space whose tab is active', () => {
    renderPanel(storyboard);

    expect(screen.getByTestId('chat-composer-space')).toHaveTextContent('Storyboard');
  });

  it('shows no chip when no tab is open', () => {
    renderPanel(undefined);

    expect(screen.queryByTestId('chat-composer-space')).toBeNull();
  });

  it('follows the tab that becomes active', () => {
    const view = renderPanel(storyboard);
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChatPanel
            projectId='p1'
            historyOpen={false}
            onHistoryOpenChange={() => undefined}
            activeSpace={cast}
            spaces={SPACES}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('chat-composer-space')).toHaveTextContent('Cast');
  });

  it('turns the open Space off and on when pressed', async () => {
    const user = userEvent.setup();
    useUIStore.getState().restoreAgentPanel('u1', 'p1');
    renderPanel(storyboard);

    await user.click(screen.getByTestId('chat-composer-space'));
    expect(useUIStore.getState().spaceContextEnabled).toBe(false);
    expect(screen.getByTestId('chat-composer-space')).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByTestId('chat-composer-space'));
    expect(useUIStore.getState().spaceContextEnabled).toBe(true);
  });

  it('sends the Spaces and the open one while it is on', async () => {
    const user = userEvent.setup();
    renderPanel(storyboard);
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    conversationRuntime.setDraft('c1', 'summarise this');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => expect(wire.sent()).toHaveLength(1));
    expect(wire.sent()[0]).toMatchObject({
      spaces: [
        { id: 's2', name: 'Storyboard', kind: 'document' },
        { id: 's1', name: 'Cast', kind: 'canvas' },
      ],
      spaces_total: 2,
      current_space: { id: 's2', kind: 'document', state: 'loading' },
    });
  });

  it('sends the Spaces without the open one while it is off', async () => {
    const user = userEvent.setup();
    renderPanel(storyboard);
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await user.click(screen.getByTestId('chat-composer-space'));

    conversationRuntime.setDraft('c1', 'which Spaces are there?');
    await user.click(screen.getByTestId('chat-composer-send'));

    await waitFor(() => expect(wire.sent()).toHaveLength(1));
    expect(wire.sent()[0]).toMatchObject({ spaces_total: 2 });
    expect(wire.sent()[0]).not.toHaveProperty('current_space');
  });
});
