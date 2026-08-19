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
 * It goes away in this migration: eviction is dropping a `Chat` instance out
 * of a map, and dropping an entry does not stop a request that is already in
 * flight. So the stop has to be asked for explicitly, and this is the test
 * that says so.
 *
 * Written against the request rather than the store's internals: what the
 * server sees is the signal being raised, and that stays true whichever end
 * holds the controller.
 *
 * 设计见 inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * §6.6 与 §13.5.2。验收 A17。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000 })),
    openChat: vi.fn(),
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
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';

const PROJECT = 'p-1';
const RUNNING = 'c-1';

/** The signal the in-flight request was handed. */
let sent: AbortSignal | null | undefined;

/**
 * Start a turn in a conversation and wait for its request to be out.
 * @param conversationId - The conversation to run it in.
 */
async function aTurnIsRunningIn(conversationId: string): Promise<void> {
  void chatSessionFor({
    projectId: PROJECT,
    conversationId,
    history: [],
    onTitled: () => undefined,
  }).sendMessage({ text: '说点什么' });
  await vi.waitFor(() => {
    expect(sent).toBeDefined();
  });
}

beforeEach(() => {
  _resetForTests();
  evictAllChatSessions();
  vi.clearAllMocks();
  sent = undefined;

  const conversation = { id: RUNNING, title: '正在跑的这条' };
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [conversation],
    hasMoreConversations: false,
    current: { conversation, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

  vi.mocked(chatApi.deleteConversation).mockResolvedValue(undefined as never);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent = init?.signal;
      // Never settles, the way the real one does not until the socket closes.
      return new Promise<Response>(() => {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deleting a conversation that is mid-turn', () => {
  it('stops the request it was running', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    await aTurnIsRunningIn(RUNNING);
    expect(sent?.aborted).toBe(false);

    await conversationRuntime.remove(PROJECT, RUNNING);

    // Without this the model keeps being called, and the reader keeps being
    // charged, for a conversation they have just deleted.
    expect(sent?.aborted).toBe(true);
  });

  it('leaves a turn in a different conversation alone', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    await aTurnIsRunningIn(RUNNING);

    await conversationRuntime.remove(PROJECT, 'c-other');

    expect(sent?.aborted).toBe(false);
  });
});
