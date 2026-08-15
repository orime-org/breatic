// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a switch, and a delete, must not do to the conversation underneath.
 *
 * Every case here started as a Gate 2 finding that reproduced. They are kept
 * because each one guards an invariant nothing else was watching: a turn
 * survives being switched away from, the last press wins, and a panel whose
 * conversation has just been deleted says it is loading rather than drawing an
 * empty conversation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSE_EVENT_NAMES } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import {
  conversationRuntime,
  turnPhaseOf,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';

const P = 'p-1';
let handlers: { onEvent: (e: SSEEventEnvelope) => void; signal?: AbortSignal };

function opens(list: Array<{ id: string; title: string | null }>, current = list[0]!.id): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: list,
    current: { conversation: list.find((c) => c.id === current)!, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

describe('switching away from a running turn and back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    vi.mocked(chatApi.streamMessage).mockImplementation((_i, h) => {
      handlers = h as typeof handlers;
      return new Promise<void>(() => {});
    });
  });

  it('keeps the turn, and keeps it stoppable', async () => {
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);

    void conversationRuntime.send(P, 'a long question');
    await vi.waitFor(() =>
      expect(useConversationRuntime.getState().conversations['c-1']?.turn).not.toBeNull(),
    );
    handlers.onEvent({
      event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
      data: { messages: [], hasMore: false, title: 'a long question' },
    } as unknown as SSEEventEnvelope);
    handlers.onEvent({
      event: SSE_EVENT_NAMES.CHAT_CHUNK,
      data: { content: 'part one' },
    } as unknown as SSEEventEnvelope);

    const signal = handlers.signal;
    const before = {
      hasTurn: useConversationRuntime.getState().conversations['c-1']?.turn !== null,
      phase: turnPhaseOf(useConversationRuntime.getState(), P),
    };

    vi.mocked(chatApi.readConversation).mockImplementation((id) =>
      Promise.resolve({
        conversation: { id, title: id },
        messages: [],
        hasMore: false,
      } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>),
    );
    await conversationRuntime.switchTo(P, 'c-2');
    await conversationRuntime.switchTo(P, 'c-1');

    const after = {
      hasTurn: useConversationRuntime.getState().conversations['c-1']?.turn !== null,
      phase: turnPhaseOf(useConversationRuntime.getState(), P),
    };
    conversationRuntime.stopTurn('c-1');
    conversationRuntime.leaveProject(P);

    expect(before.hasTurn).toBe(true);
    expect(after.hasTurn).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

describe('two switches whose answers come back out of order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('lands on the one the reader pressed last', async () => {
    opens([
      { id: 'c-1', title: 'one' },
      { id: 'c-2', title: 'two' },
      { id: 'c-3', title: 'three' },
    ]);
    await conversationRuntime.ensureLoaded(P);

    vi.mocked(chatApi.readConversation).mockImplementation((id) => {
      const answer = {
        conversation: { id, title: id },
        messages: [],
        hasMore: false,
      } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>;
      return id === 'c-2'
        ? new Promise((r) => setTimeout(() => r(answer), 30))
        : Promise.resolve(answer);
    });

    const slow = conversationRuntime.switchTo(P, 'c-2');
    const fast = conversationRuntime.switchTo(P, 'c-3');
    await Promise.all([slow, fast]);

    expect(useConversationRuntime.getState().currentByProject[P]).toBe('c-3');
  });
});

describe('deleting the conversation on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  it('does not draw an empty conversation while the next one is on its way', async () => {
    opens([{ id: 'c-1', title: 'one' }, { id: 'c-2', title: 'two' }]);
    await conversationRuntime.ensureLoaded(P);
    vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined);
    vi.mocked(chatApi.readConversation).mockRejectedValue(new Error('offline'));

    await conversationRuntime.remove(P, 'c-1');

    // What matters is what the panel draws, not which id an internal map
    // happens to hold: the empty-conversation greeting is gated on this
    // status, so anything but `ready` keeps it off the screen. Landing on
    // `failed` also puts the scrim up, which is the right answer when the
    // conversation meant to replace it could not be read.
    expect(useConversationRuntime.getState().openStatus[P]).not.toBe('ready');
  });
});
