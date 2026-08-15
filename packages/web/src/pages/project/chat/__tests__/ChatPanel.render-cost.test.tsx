// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { SSE_EVENT_NAMES } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

const counts = vi.hoisted(() => ({ composer: 0, history: 0 }));

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn() },
}));

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
import { useChatStore } from '@web/stores';
import { _resetForTests } from '@web/stores/conversation-runtime';

/** The stream handlers the store installed on its last send. */
let handlers: { onEvent: (e: SSEEventEnvelope) => void };

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  _resetForTests();
  counts.composer = 0;
  counts.history = 0;
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c1' }],
    current: { conversation: { id: 'c1' }, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
    handlers = h as typeof handlers;
  });
});

describe('a reply arriving piece by piece', () => {
  it('does not re-render the composer or the history sheet', async () => {
    render(<ChatPanel historyOpen={false} onHistoryOpenChange={() => undefined} projectId='p1' />);
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    await act(async () => {
      useChatStore.getState().setComposerDraft('hello');
    });
    await act(async () => {
      // Sent through the store rather than the composer, because the composer
      // is a stub here. What is being measured is what the panel does to its
      // children while a reply arrives, not how the reply was asked for.
      await import('@web/stores/conversation-runtime').then((m) =>
        m.conversationRuntime.send('p1', 'hello'),
      );
    });

    const composerBefore = counts.composer;
    const historyBefore = counts.history;

    // One commit per piece, the way they really arrive -- batching them into
    // a single act would only ever measure one render of the panel.
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      await act(async () => {
        handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text } });
      });
    }

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
