// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Deleting a conversation that a run holds (inner#1717).
 *
 * A run left going for a conversation that no longer exists goes on calling
 * the model and goes on being charged for, on behalf of a user who has just
 * said they are done with it. The run is the server's: the delete route
 * clears its queue and stops it there. What the page owes is to let go of the
 * run's stream it was reading, without a stop request of its own, and to
 * leave the stream of any other conversation alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { replyOpens, settle, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const PROJECT = 'p-1';
const RUNNING = 'c-1';

/** What a sync answers when nothing holds the conversation. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

let wire: RunWire;

/**
 * Attach to the run that holds a conversation, as the page does for the one
 * on screen.
 * @param conversationId - The conversation the run holds.
 */
async function aRunIsReadIn(conversationId: string): Promise<void> {
  chatSessionFor({ projectId: PROJECT, conversationId, history: [], onTitled: () => undefined });
  vi.mocked(chatApi.sync).mockResolvedValueOnce({ ...IDLE, running: true });
  chatLive.show(PROJECT, conversationId);
  await settle();
  for (const chunk of replyOpens()) wire.last()?.push(chunk);
  await settle();
  expect(wire.streams()).toHaveLength(1);
}

beforeEach(() => {
  _resetForTests();
  evictAllChatSessions();
  wire = stubRunWire();

  const conversation = { id: RUNNING, title: 'the one running' };
  vi.spyOn(chatApi, 'openChat').mockResolvedValue({
    conversations: [conversation],
    hasMoreConversations: false,
    current: { conversation, messages: [], hasMore: false },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
  vi.spyOn(chatApi, 'deleteConversation').mockResolvedValue(undefined as never);
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue({ conversation: conversation as never, messages: [], hasMore: false });
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
});

afterEach(() => {
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deleting a conversation that is mid-turn', () => {
  it('asks the server to delete it and lets go of its stream, with no stop request of its own (WB-40)', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    await aRunIsReadIn(RUNNING);
    expect(wire.last()?.abandoned()).toBe(false);

    await conversationRuntime.remove(PROJECT, RUNNING);

    expect(chatApi.deleteConversation).toHaveBeenCalledWith(RUNNING);
    expect(wire.last()?.abandoned()).toBe(true);
    expect(chatApi.stop).not.toHaveBeenCalled();
  });

  it('leaves the stream of a different conversation alone', async () => {
    await conversationRuntime.ensureLoaded(PROJECT);
    await aRunIsReadIn(RUNNING);

    await conversationRuntime.remove(PROJECT, 'c-other');

    expect(wire.last()?.abandoned()).toBe(false);
  });
});
