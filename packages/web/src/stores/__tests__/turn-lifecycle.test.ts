// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Who writes which fact between a press of send and the end of the run it
 * joins (inner#1717).
 *
 * A message is its own request, and the page draws nothing of it until the
 * server holds it, so a refused message never shows in the list and its words
 * stay in the box. A run is read from the server's stream: the message that
 * opened it comes from the history read before attaching, so a run that fails
 * after it began keeps it. The beat watchdog is armed while a stream is read,
 * and arming it asks the server for the beat interval first, a round trip
 * that can outlast the read; an answer that comes back after the read ended
 * arms nothing. The "folding memory" line follows the stream, and so does
 * the thinking figure of a reply that failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage, StreamConfig } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, evictAllChatSessions, isReadingRun } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { useConsolidating } from '@web/stores/consolidating';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { BEAT, replyEnds, replyOpens, settle, stubRunWire, type RunStream, type RunWire } from '@web/test-utils/chat-run-wire';

const BEAT_MS = 5000;

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 600_000 };
const RUNNING: ChatSyncAnswer = { ...IDLE, running: true };

/** What the server says about its streams. */
const CONFIG: StreamConfig = {
  heartbeatIntervalMs: BEAT_MS, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
  spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 600_000,
};

/** The message that opened the run, as the history holds it. */
const OPENING: StoredUiMessage = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'find references' }], metadata: { turnIndex: 1, ts: '' } };

/** Every sentence said. */
let told: ChatMishap[] = [];
let stopWatching: (() => void) | undefined;
let wire: RunWire;

/**
 * While true, each ask for the stream config made while a run's stream is
 * read (the watchdog's) waits until the case answers it.
 */
let holdConfig = false;

/** The asks for the stream config that wait, oldest first. */
let heldConfig: Array<(value: StreamConfig) => void> = [];

/**
 * The conversation's session.
 * @returns Its `Chat`.
 */
function aConversation(): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined });
}

/**
 * Send a message.
 * @param words - What is typed.
 * @returns How the send ended.
 */
function sendIt(words = 'find references'): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words, chips: [], spaces: {} });
}

/**
 * Show the conversation while a run holds it, and wait for the page to attach.
 * @param wait - How to let the page get there.
 * @returns The stream it attached to.
 */
async function attachToARun(wait: () => Promise<void> = settle): Promise<RunStream> {
  vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
  chatLive.show('p-1', 'c-1');
  await wait();
  return wire.last()!;
}

/**
 * Write a whole reply on a stream and end it.
 * @param s - The stream.
 * @param textId - The reply's text part.
 */
function answerAndEnd(s: RunStream, textId = 't1'): void {
  for (const f of replyOpens(textId)) s.push(f);
  s.push({ type: 'text-delta', id: textId, delta: 'fine' });
  for (const f of replyEnds(textId)) s.push(f);
  s.close();
}

beforeEach(() => {
  wire = stubRunWire();
  holdConfig = false;
  heldConfig = [];
  vi.spyOn(chatApi, 'streamConfig').mockImplementation(() =>
    holdConfig && isReadingRun('c-1') ? new Promise<StreamConfig>((resolve) => heldConfig.push(resolve)) : Promise.resolve(CONFIG),
  );
  vi.spyOn(chatApi, 'readConversation').mockImplementation(async (): Promise<ConversationRead> => ({
    conversation: { id: 'c-1' } as never,
    messages: [OPENING],
    hasMore: false,
  }));
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'queued', pending: [], running: false });
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
  vi.useRealTimers();
});

describe('a message the server refuses', () => {
  beforeEach(() => {
    conversationRuntime.setDraft('c-1', 'find references');
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(new ApiException({ status: 402, message: 'Out of credits.', fromServer: true }));
  });

  it('draws nothing of it in the list', async () => {
    await sendIt();
    await settle();

    expect(aConversation().messages).toHaveLength(0);
  });

  it('leaves the words where the user typed them', async () => {
    await sendIt();
    await settle();

    expect(conversationRuntime.draftOf('c-1')).toBe('find references');
  });

  it('relays the sentence the server wrote', async () => {
    await sendIt();
    await settle();

    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: 'server', message: 'Out of credits.' });
  });
});

describe('a run that fails after its reply began', () => {
  it('keeps the message that opened it: the server stored it before the run said anything', async () => {
    const s = await attachToARun();
    s.push(BEAT);
    s.push({ type: 'start' });
    await settle();

    // Building the history or calling the model failed; the run writes an error frame.
    s.push({ type: 'error', errorText: 'The turn could not be run.' });
    s.close();
    await settle();

    const messages = aConversation().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });
});

describe('a conversation whose last run was answered, then a message refused', () => {
  it('keeps that run as it was and shows nothing of the refused message', async () => {
    const s = await attachToARun();
    answerAndEnd(s);
    await settle();
    expect(aConversation().messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(new ApiException({ status: 402, message: 'Out of credits.', fromServer: true }));
    await sendIt('the second one');
    await settle();

    expect(aConversation().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('the ask for the beat interval outlasting the read', () => {
  /**
   * Let what is queued run, without moving the clock.
   */
  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
  }

  /**
   * Answer every ask for the stream config that waits.
   */
  function answerHeld(): void {
    for (const answer of heldConfig.splice(0)) answer(CONFIG);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('arms nothing for a refused message: no stream is read, so nothing is watched', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(new ApiException({ status: 404, message: 'This conversation is gone.', fromServer: true }));
    await sendIt();
    await flush();
    expect(told).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(BEAT_MS * 4);
    await flush();

    expect(told).toHaveLength(1);
    expect(aConversation().messages).toHaveLength(0);
  });

  it('takes the watch down when the read ends normally', async () => {
    // Left up, it would go off while the next run is read and let go of it,
    // telling a network problem about a run that is fine.
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING);
    chatLive.show('p-1', 'c-1');
    await flush();
    answerAndEnd(wire.streams()[0]!);
    // The next read's own ask is slow, so only the first read's watch could go off.
    holdConfig = true;
    await flush();
    expect(wire.streams()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(BEAT_MS * 4);
    await flush();

    const second = wire.last()!;
    expect(second.abandoned()).toBe(false);
    expect(told).toEqual([]);
    holdConfig = false;
    answerHeld();
    answerAndEnd(second, 't2');
    await flush();
    expect(told).toEqual([]);
  });

  it('does not let the answer of an earlier read cut a later read short', async () => {
    holdConfig = true;
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING);
    chatLive.show('p-1', 'c-1');
    await flush();
    // The first read's ask is held while it ends; the next one opens.
    answerAndEnd(wire.streams()[0]!);
    await flush();
    expect(wire.streams()).toHaveLength(2);

    // The first read's answer comes back only now, while the second is read.
    holdConfig = false;
    answerHeld();
    await flush();
    const second = wire.last()!;
    for (let beat = 0; beat < 4; beat += 1) {
      await vi.advanceTimersByTimeAsync(BEAT_MS);
      second.push(BEAT);
      await flush();
    }
    answerAndEnd(second, 't2');
    await flush();

    expect(second.abandoned()).toBe(false);
    expect(told).toEqual([]);
  });

  it('arms nothing when the answer comes back after the read ended, so the next run is not cut short', async () => {
    // The conversation outlives every read, so asking whether it is still
    // there lets the late answer through; it is the read that has to be.
    holdConfig = true;
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p-1', 'c-1');
    await flush();
    answerAndEnd(wire.last()!);
    await flush();

    // The first read's answer comes back only now, with nothing being read.
    answerHeld();
    await flush();

    // The next run is read at once, its own ask slow again.
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.hide('c-1');
    chatLive.show('p-1', 'c-1');
    await flush();
    expect(wire.streams()).toHaveLength(2);
    const second = wire.last()!;
    await vi.advanceTimersByTimeAsync(BEAT_MS * 4);
    await flush();

    expect(second.abandoned()).toBe(false);
    expect(told).toEqual([]);
    holdConfig = false;
    answerHeld();
    answerAndEnd(second, 't2');
    await flush();
    expect(told).toEqual([]);
  });
});

describe('a run that stops to fold memory', () => {
  /**
   * Whether the conversation is folding memory now.
   * @returns True when it is.
   */
  function folding(): boolean {
    return useConsolidating.getState().byConversation['c-1'] === true;
  }

  it('is noted when the server says it folds', async () => {
    // A long conversation folds before the next answer, one whole model call
    // the user waits through looking at an empty reply.
    const s = await attachToARun();
    expect(folding()).toBe(false);

    // The title frame comes first: the server writes it every run, and the
    // folding starts after it.
    s.push({ type: 'data-conversation-titled', data: { title: 'One line' } });
    s.push({ type: 'data-memory-consolidating', transient: true, data: {} });
    await settle();

    expect(folding()).toBe(true);
  });

  it('is no longer said once the reply starts', async () => {
    const s = await attachToARun();
    s.push({ type: 'data-conversation-titled', data: { title: 'One line' } });
    s.push({ type: 'data-memory-consolidating', transient: true, data: {} });
    await settle();

    for (const f of replyOpens('t1')) s.push(f);
    await settle();

    expect(folding()).toBe(false);
  });

  it('is no longer said once the stream ends, even with not a word said', async () => {
    // A failed fold, a model error and a stop all end this way. Left, the line
    // would still be there the next time the conversation is opened.
    const s = await attachToARun();
    s.push({ type: 'data-memory-consolidating', transient: true, data: {} });
    await settle();

    s.close();
    await settle();

    expect(folding()).toBe(false);
  });
});

describe('the thinking figure on a run that fails', () => {
  /**
   * Read one run that thought and then failed, its frames in the given order.
   * @param ending - The frames after the thinking, in wire order.
   * @returns The parts the reply holds once the read has ended.
   */
  async function failedReplyParts(ending: Array<Record<string, unknown>>): Promise<string[]> {
    const s = await attachToARun();
    s.push(BEAT);
    s.push({ type: 'start', messageId: 'm-reply' });
    s.push({ type: 'start-step' });
    s.push({ type: 'reasoning-start', id: 'r1' });
    s.push({ type: 'reasoning-delta', id: 'r1', delta: 'weighing it up' });
    s.push({ type: 'reasoning-end', id: 'r1' });
    s.push({ type: 'finish-step' });
    for (const chunk of ending) s.push(chunk);
    s.close();
    await settle();
    return (aConversation().messages.at(-1)?.parts ?? []).map((part) => part.type);
  }

  it('keeps the figure when it comes before the error frame, which is the order the server writes', async () => {
    const parts = await failedReplyParts([
      { type: 'data-thinking-time', data: { ms: 3000 } },
      { type: 'error', errorText: 'The turn could not be run.' },
    ]);

    expect(parts).toContain('data-thinking-time');
  });

  it('drops a figure that comes after the error frame: the SDK Chat stops reading there', async () => {
    const parts = await failedReplyParts([
      { type: 'error', errorText: 'The turn could not be run.' },
      { type: 'data-thinking-time', data: { ms: 3000 } },
    ]);

    expect(parts).toContain('reasoning');
    expect(parts).not.toContain('data-thinking-time');
  });
});
