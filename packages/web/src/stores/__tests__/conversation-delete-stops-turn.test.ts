// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Deleting a conversation stops whatever it was running.
 *
 * A turn left running for a conversation that no longer exists goes on
 * calling the model and goes on being charged for, on behalf of a reader who
 * has just said they are done with it. The reason is written beside the call
 * in `conversation-runtime.ts`; what was missing is anything that notices if
 * the call goes away.
 *
 * It goes away in this migration: eviction moves to dropping a `Chat`
 * instance out of a map, and dropping an entry does not stop a request that
 * is already in flight. So the stop has to be asked for explicitly, and this
 * is the test that says so.
 *
 * Written against the request rather than the store's internals: what the
 * server sees is the signal being raised, and that stays true whichever end
 * holds the controller.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 6.6 and 13.5.2. Acceptance A17.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    openChat: vi.fn(),
    streamMessage: vi.fn(),
    messagesBefore: vi.fn(),
    readConversation: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
  },
}));

import { chatApi } from '@web/data/api/chat';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';

const PROJECT = 'p-1';
const RUNNING = 'c-1';

/** The signal the in-flight request was handed. */
let sent: AbortSignal | undefined;

beforeEach(() => {
  _resetForTests();
  vi.clearAllMocks();
  sent = undefined;

  const conversation = { id: RUNNING, title: '正在跑的这条' };
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [conversation],
    hasMoreConversations: false,
    current: { conversation, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

  vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);

  vi.mocked(chatApi.streamMessage).mockImplementation((_input, options) => {
    sent = (options as { signal?: AbortSignal }).signal;
    // Never settles, the way the real one does not until the socket closes.
    return new Promise<void>(() => {});
  });
});

describe('deleting a conversation that is mid-turn', () => {
  it('stops the request it was running', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    void conversationRuntime.send(PROJECT, '说点什么');
    await vi.waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    expect(sent).toBeDefined();
    expect(sent?.aborted).toBe(false);

    await conversationRuntime.remove(PROJECT, RUNNING);

    // Without this the model keeps being called, and the reader keeps being
    // charged, for a conversation they have just deleted.
    expect(sent?.aborted).toBe(true);
  });

  it('leaves a turn in a different conversation alone', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    void conversationRuntime.send(PROJECT, '说点什么');
    await vi.waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    await conversationRuntime.remove(PROJECT, 'c-other');

    expect(sent?.aborted).toBe(false);
  });
});
