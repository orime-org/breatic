// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a streaming reply costs the rest of the panel.
 *
 * Every piece of a reply rewrites one message, which re-renders the panel
 * that holds the list. Nothing else in the column has changed -- not the
 * composer, not the history sheet -- so nothing else should be rendered
 * again, sixty times a second, for the length of a turn.
 *
 * Two halves make that true and each can be broken on its own: the children
 * have to be memoised, and the panel has to hand them props that stay the
 * same. A memoised child given a new callback every render never bails out,
 * which is the same as not being memoised at all.
 */

import type * as ChatApiModule from '@web/data/api/chat';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

const counts = vi.hoisted(() => ({ composer: 0, history: 0 }));

vi.mock('@web/data/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatApiModule>();
  return {
    ...actual,
    chatApi: {
      openChat: vi.fn(),
      streamConfig: vi.fn(),
      readConversation: vi.fn(),
      running: vi.fn(),
      sync: vi.fn(),
      streamPath: actual.chatApi.streamPath,
    },
  };
});

// Stand-ins that count. Memoised the way the real ones are, so what a count
// that grows says is "the props changed", which is the half of this the panel
// itself owns. That the real components are memoised is asserted below.
vi.mock('@web/pages/project/chat/ChatComposer', async () => {
  const react = await import('react');
  return {
    ChatComposer: react.memo(function ComposerStub(): React.JSX.Element {
      counts.composer++;
      return <div data-testid='composer-stub' />;
    }),
  };
});

vi.mock('@web/pages/project/chat/ConversationHistorySheet', async () => {
  const react = await import('react');
  return {
    ConversationHistorySheet: react.memo(function HistoryStub(): React.JSX.Element {
      counts.history++;
      return <div data-testid='history-stub' />;
    }),
  };
});

import { chatApi } from '@web/data/api/chat';
import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { ConversationHistorySheet } from '@web/pages/project/chat/ConversationHistorySheet';
import { _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetChatLiveForTests } from '@web/stores/chat-live';
import { replyOpens, stubRunWire } from '@web/test-utils/chat-run-wire';
import type { RunWire } from '@web/test-utils/chat-run-wire';

/** The run streams the page reads, which the test pushes into. */
let wire: RunWire;

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  evictAllChatSessions();
  counts.composer = 0;
  counts.history = 0;
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: { conversation: { id: 'c1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } }, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  vi.mocked(chatApi.streamConfig).mockResolvedValue({
    heartbeatIntervalMs: 5000,
    attachmentMaxChars: 200_000,
    attachmentMaxItems: 10,
    currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200,
    spaceReadTimeoutMs: 20_000,
    runningPollIntervalMs: 5000,
    syncIntervalMs: 3000,
  });
  vi.mocked(chatApi.readConversation).mockResolvedValue({
    conversation: { id: 'c1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
    messages: [],
    hasMore: false,
  } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
  vi.mocked(chatApi.sync).mockResolvedValue({ pending: [], running: false, awaiting: false, next_sync_ms: 3000 });
  vi.mocked(chatApi.running).mockResolvedValue([]);
  wire = stubRunWire();
});

afterEach(() => {
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.unstubAllGlobals();
});

describe('the project meta being re-read (inner#1413)', () => {
  it('does not re-render the composer when the Spaces are re-read unchanged', async () => {
    /**
     * The panel with the Spaces as the project meta hands them: a fresh array
     * and fresh objects each time it is re-read, as when someone goes online.
     * @returns The panel.
     */
    const panel = (): React.JSX.Element => {
      const spaces = [
        { id: 's1', name: 'Cast', type: 'canvas' as const, createdAt: 1 },
        { id: 's2', name: 'Storyboard', type: 'document' as const, createdAt: 2 },
      ];
      return (
        <QueryClientProvider client={client}>
          <ChatPanel
            historyOpen={false}
            onHistoryOpenChange={() => undefined}
            projectId='p1'
            activeSpace={spaces[1]}
            spaces={spaces}
          />
        </QueryClientProvider>
      );
    };
    const client = new QueryClient();
    const view = render(panel());
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const before = counts.composer;

    view.rerender(panel());
    view.rerender(panel());

    expect(counts.composer).toBe(before);
  });
});

describe('a reply arriving piece by piece', () => {
  it('does not re-render the composer or the history sheet', async () => {
    // A run holds the conversation when it opens, so the panel attaches to it
    // (inner#1717). What is being measured is what the panel does to its
    // children while a reply arrives, not how the reply was asked for.
    vi.mocked(chatApi.sync).mockResolvedValue({ pending: [], running: true, awaiting: false, next_sync_ms: 3000 });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatPanel historyOpen={false} onHistoryOpenChange={() => undefined} projectId='p1' activeSpace={undefined} spaces={[]} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    await waitFor(() => {
      expect(wire.last()).not.toBeNull();
    });
    await act(async () => {
      for (const chunk of replyOpens()) wire.last()?.push(chunk);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const composerBefore = counts.composer;
    const historyBefore = counts.history;

    // One commit per piece, the way they really arrive -- batching them into
    // a single act would only ever measure one render of the panel.
    for (const delta of ['a', 'b', 'c', 'd', 'e']) {
      await act(async () => {
        wire.last()?.push({ type: 'text-delta', id: 't1', delta });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // The premise first: an assertion about what a growing reply costs proves
    // nothing if the reply never grew, and counts that stay put is exactly
    // what a turn that never arrived looks like.
    await waitFor(() => {
      expect(screen.getAllByTestId('message-bubble-content').at(-1)).toHaveTextContent('abcde');
    });
    expect(counts.composer).toBe(composerBefore);
    expect(counts.history).toBe(historyBefore);
  });

  it('meets the other half: both children are memoised', () => {
    // Without this the counting above proves only that the props are stable,
    // and stable props reach a component that re-renders anyway.
    expect(ChatComposer).toHaveProperty('$$typeof', Symbol.for('react.memo'));
    expect(ConversationHistorySheet).toHaveProperty('$$typeof', Symbol.for('react.memo'));
  });
});
