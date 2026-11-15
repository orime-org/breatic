// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which sentence the user hears when a message or a run does not go through
 * (inner#1717).
 *
 * A message is its own request now, and a run is read from the server's
 * stream, so the cases sit in two places. A refused send relays the sentence
 * the server wrote. A run's stream that ends in an error the server reported
 * says "this reply is not coming". A connection that breaks while the run is
 * read is the network's doing, and the page attaches again: the run goes on
 * on the server. The user's own stop says nothing. What is said while nobody
 * listens is not kept for later.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { replyOpens, settle, stubRunWire, type RunStream, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };
const RUNNING: ChatSyncAnswer = { ...IDLE, running: true };

/** The message that opened the run, as the history holds it. */
const OPENING: StoredUiMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'find some references' }], metadata: { turnIndex: 1, ts: '' } };

/** Every sentence said. */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;
let wire: RunWire;

/**
 * The newest page of history.
 * @returns The answer.
 */
function page(): ConversationRead {
  return { conversation: { id: 'c-1' } as never, messages: [OPENING], hasMore: false };
}

/**
 * The conversation's session.
 * @returns Its `Chat`.
 */
function aConversation(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined });
}

/**
 * Send a message and wait for the server's answer.
 * @returns How the send ended.
 */
function sendIt(): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'find some references', chips: [], spaces: {} });
}

/**
 * Show the conversation while a run holds it, and wait for the page to attach.
 * @returns The stream it attached to.
 */
async function attachToARun(): Promise<RunStream> {
  vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
  chatLive.show('p-1', 'c-1');
  await settle();
  return wire.last()!;
}

beforeEach(() => {
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 600_000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue(page());
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'queued', pending: [], running: false });
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
  aConversation();
});

afterEach(() => {
  stopWatching?.();
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a message or a run that does not go through', () => {
  it('relays the sentence the server wrote, in its own language', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 402, message: 'You are out of credits.', fromServer: true }),
    );

    await sendIt();

    expect(told).toEqual([
      expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'server', message: 'You are out of credits.' }),
    ]);
  });

  it('says only that this reply is not coming when the run\'s stream ends in an error', async () => {
    const s = await attachToARun();
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'error', errorText: 'The turn could not be run.' });
    s.close();
    await settle();

    expect(told.map((m) => m.kind)).toEqual(['turn']);
  });

  it('calls a connection that broke the network\'s doing, and attaches again', async () => {
    const s = await attachToARun();
    for (const f of replyOpens()) s.push(f);
    await settle();
    s.breakOff();
    await settle();

    expect(told.map((m) => m.kind)).toEqual(['network']);
    expect(wire.streams()).toHaveLength(2);
    expect(chatApi.stop).not.toHaveBeenCalled();
  });

  it('says nothing about the user\'s own stop', async () => {
    const s = await attachToARun();
    for (const f of replyOpens()) s.push(f);
    await settle();

    await chatLive.stop('p-1', 'c-1');
    s.push({ type: 'data-interrupted', data: {} });
    s.close();
    await settle();

    // They just did it; there is no need to tell them again.
    expect(told).toEqual([]);
  });

  it('keeps nothing said while nobody listens to tell later', async () => {
    stopWatching?.();
    stopWatching = undefined;
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 402, message: 'You are out of credits.', fromServer: true }),
    );

    await sendIt();

    // Watching now is the user coming back: they hear nothing. What they see
    // is the words still in the box; nothing holds the sentence for them.
    const late: ChatMishap[] = [];
    const stop = watchChatMishaps((mishap) => late.push(mishap));
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(late).toEqual([]);
  });
});
