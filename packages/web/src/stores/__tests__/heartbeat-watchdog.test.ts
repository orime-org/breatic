// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How long a run's stream may go quiet before the server running it counts as
 * gone (inner#1717).
 *
 * A server that dies without closing the connection does not error and does
 * not close; it just never says anything again. The run writes a beat on its
 * stream at every interval, so a page reading it and hearing no beat for
 * `SSE_HEARTBEAT_MISSES_ALLOWED` intervals lets go of the stream, tells the
 * user once that the network let them down, reads the history back and
 * attaches again (the next run, if one opens, is read from there). The run is
 * the server's: nothing is stopped, no stop mark is drawn, and nothing the
 * user sent is taken back.
 *
 * The count runs while a stream is read, from when it opened; a beat starts
 * it again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSE_HEARTBEAT_MISSES_ALLOWED } from '@breatic/shared';
import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { BEAT, replyOpens, stubRunWire, type RunStream, type RunWire } from '@web/test-utils/chat-run-wire';

const BEAT_MS = 5000;

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 600_000 };

/** The message that opened the run, as the history holds it. */
const OPENING: StoredUiMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'find some references' }], metadata: { turnIndex: 1, ts: '' } };

let wire: RunWire;
/** Every sentence said. */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;

/**
 * The conversation's session.
 * @returns Its `Chat`.
 */
function aConversation(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined });
}

/**
 * Let what is queued run, without moving the clock.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
}

/**
 * Show the conversation while a run holds it, and wait for the page to attach.
 * @returns The stream it attached to.
 */
async function attachToARun(): Promise<RunStream> {
  vi.mocked(chatApi.sync).mockResolvedValueOnce({ ...IDLE, running: true });
  chatLive.show('p-1', 'c-1');
  await flush();
  return wire.last()!;
}

beforeEach(() => {
  vi.useFakeTimers();
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: BEAT_MS, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 600_000,
  });
  vi.spyOn(chatApi, 'readConversation').mockImplementation(async (): Promise<ConversationRead> => ({
    conversation: { id: 'c-1' } as never,
    messages: [OPENING],
    hasMore: false,
  }));
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
  told = [];
  stopWatching = watchChatMishaps((mishap) => told.push(mishap));
  aConversation();
});

afterEach(() => {
  stopWatching?.();
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('a stream that goes quiet', () => {
  it('is let go of after the allowed misses, told about once, read again and attached to again', async () => {
    const first = await attachToARun();

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);
    await flush();

    expect(first.abandoned()).toBe(true);
    expect(told.map((m) => m.kind)).toEqual(['network']);
    expect(chatApi.readConversation).toHaveBeenCalledTimes(2);
    expect(wire.streams()).toHaveLength(2);
    expect(chatApi.stop).not.toHaveBeenCalled();
  });

  it('is not let go of one miss short', async () => {
    const first = await attachToARun();

    await vi.advanceTimersByTimeAsync(BEAT_MS * (SSE_HEARTBEAT_MISSES_ALLOWED - 1));
    await flush();

    expect(first.abandoned()).toBe(false);
    expect(told).toEqual([]);
  });

  it('starts counting again at every beat', async () => {
    const first = await attachToARun();

    // A beat just short of the line, then as long again. Without the restart
    // the stream would be let go of by now.
    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED - 100);
    first.push(BEAT);
    await flush();
    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED - 100);

    expect(first.abandoned()).toBe(false);
    expect(told).toEqual([]);
  });

  it('takes back nothing the user sent: the opening message stays and the box is left alone', async () => {
    conversationRuntime.setDraft('c-1', 'typed meanwhile');
    await attachToARun();

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);
    await flush();

    expect(aConversation().messages.map((m) => m.id)).toEqual(['u-1']);
    expect(conversationRuntime.draftOf('c-1')).toBe('typed meanwhile');
  });

  it('draws the reply once when the replay comes after attaching again, with no stop mark', async () => {
    const first = await attachToARun();
    for (const f of replyOpens()) first.push(f);
    first.push({ type: 'text-delta', id: 't1', delta: 'so far' });
    await flush();

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);
    await flush();
    const again = wire.last()!;
    for (const f of replyOpens()) again.push(f);
    again.push({ type: 'text-delta', id: 't1', delta: 'so far' });
    await flush();

    const messages = aConversation().messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]!.parts.filter((p) => p.type === 'text')).toEqual([expect.objectContaining({ text: 'so far' })]);
    expect(messages.some((m) => m.parts.some((p) => p.type === 'data-interrupted'))).toBe(false);
  });
});
