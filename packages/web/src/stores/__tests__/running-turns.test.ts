// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which conversations have a turn running on this page (#1394).
 *
 * The conversation list marks them, so the store has to hold a conversation
 * for exactly as long as this page reads its run (inner#1717): from the
 * moment the run's stream is handed over to the moment that stream ends,
 * whichever way it ended, or the page lets go of it. Each ending is driven
 * here through a real `Chat` reading a stubbed run stream rather than by
 * calling the store directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import { SSE_HEARTBEAT_MISSES_ALLOWED } from '@breatic/shared';
import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatSessionFor, evictAllChatSessions, evictChatSession } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import {
  clearRunningTurns,
  noteTurnRunning,
  noteTurnSettled,
  useRunningTurns,
} from '@web/stores/running-turns';
import { BEAT, replyEnds, replyOpens, settle, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const BEAT_MS = 1000;

/** What a sync answers when nothing holds the conversation. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** What a sync answers while a run holds it. */
const RUNNING: ChatSyncAnswer = { ...IDLE, running: true };

let wire: RunWire;

/**
 * Whether the store holds this conversation as running.
 * @param conversationId - The conversation.
 * @returns True while it is held.
 */
function running(conversationId = 'c-1'): boolean {
  return useRunningTurns.getState().byConversation[conversationId] === true;
}

/**
 * Open a conversation's session.
 * @param conversationId - Which one.
 * @param history - What it already holds.
 * @returns Its `Chat`.
 */
function aConversation(
  conversationId = 'c-1',
  history: StoredUiMessage[] = [],
): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({
    projectId: 'p-1',
    conversationId,
    history,
    onTitled: () => undefined,
  });
}

/**
 * Show a conversation whose run the first sync says is going, and let the
 * page attach to it.
 * @param conversationId - Which one.
 */
async function attachTo(conversationId = 'c-1'): Promise<void> {
  vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
  chatLive.show('p-1', conversationId);
  await settle();
}

/** A reply paused on a questionnaire, waiting on the user. */
const PAUSED: StoredUiMessage[] = [
  { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'make me a poster' }], metadata: { turnIndex: 1, ts: '' } },
  {
    id: 'a-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Two things first.' },
      { type: 'tool-ask_user', toolCallId: 'ask-1', state: 'input-available', input: { questions: [] } },
      { type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } },
    ] as StoredUiMessage['parts'],
    metadata: { turnIndex: 1, ts: '' },
  },
];

/**
 * Answer the paused questionnaire.
 * @returns When the answer is settled.
 */
function answerTheCard(): Promise<void> {
  return chatLive.answerCard({
    projectId: 'p-1',
    conversationId: 'c-1',
    toolCallId: 'ask-1',
    card: { answer: { toolCallId: 'ask-1', answers: [{ index: 0, selected: ['9:16'] }] } },
    spaces: {},
  });
}

beforeEach(() => {
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: BEAT_MS,
    attachmentMaxChars: 200_000,
    attachmentMaxItems: 10,
    currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200,
    spaceReadTimeoutMs: 10_000,
    runningPollIntervalMs: 5000,
    syncIntervalMs: 3_000,
  });
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue({ conversation: { id: 'c-1' } as never, messages: [], hasMore: false });
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'start', pending: [], running: true });
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
});

afterEach(() => {
  resetChatLiveForTests();
  evictAllChatSessions();
  clearRunningTurns();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the store on its own', () => {
  it('holds a conversation from running until settled, and leaves the others alone', () => {
    noteTurnRunning('c-1');
    noteTurnRunning('c-2');
    expect(useRunningTurns.getState().byConversation).toEqual({ 'c-1': true, 'c-2': true });

    noteTurnSettled('c-1');
    expect(useRunningTurns.getState().byConversation).toEqual({ 'c-2': true });
  });

  it('forgets every conversation at once', () => {
    noteTurnRunning('c-1');
    noteTurnRunning('c-2');

    clearRunningTurns();

    expect(useRunningTurns.getState().byConversation).toEqual({});
  });
});

describe('a run this page reads', () => {
  it('is held once its stream is handed over, before any reply comes back', async () => {
    aConversation();

    await attachTo();

    expect(wire.streams()).toHaveLength(1);
    expect(running()).toBe(true);
  });

  it('is not held for a send the server refused', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 402, message: 'Not enough credits.', fromServer: true }),
    );
    aConversation();
    chatLive.show('p-1', 'c-1');
    await settle();

    await chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'find references', chips: [], spaces: {} });
    await settle();

    expect(wire.streams()).toHaveLength(0);
    expect(running()).toBe(false);
  });

  it('is held from the answer to a send that opened a run', async () => {
    aConversation();
    chatLive.show('p-1', 'c-1');
    await settle();

    await chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'find references', chips: [], spaces: {} });
    await settle();

    expect(wire.streams()).toHaveLength(1);
    expect(running()).toBe(true);
  });

  it('is let go once the reply finishes', async () => {
    const chat = aConversation();
    await attachTo();
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Here.' });
    await settle();
    expect(running()).toBe(true);

    for (const chunk of replyEnds()) wire.last()?.push(chunk);
    wire.last()?.close();
    await settle();

    expect(chat.status).toBe('ready');
    expect(running()).toBe(false);
  });

  it('is let go when the user stops it and the stream says so', async () => {
    aConversation();
    await attachTo();
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    await settle();
    expect(running()).toBe(true);

    await chatLive.stop('p-1', 'c-1');
    await settle();
    expect(chatApi.stop).toHaveBeenCalledWith('c-1', 'p-1');
    wire.last()?.push({ type: 'data-interrupted', data: {} });
    wire.last()?.close();
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the reply fails partway', async () => {
    const chat = aConversation();
    await attachTo();
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    wire.last()?.push({ type: 'data-failed', data: {} });
    wire.last()?.push({ type: 'error', errorText: 'The turn could not be run.' });
    wire.last()?.close();
    await settle();

    expect(chat.status).toBe('error');
    expect(running()).toBe(false);
  });

  it('is never held when the stream request never reaches the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    aConversation();

    await attachTo();

    expect(running()).toBe(false);
  });

  it('is let go when the connection breaks and no run holds the conversation any more', async () => {
    aConversation();
    await attachTo();
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    await settle();
    expect(running()).toBe(true);

    wire.noRunNext();
    wire.last()?.breakOff();
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the stream goes silent and no run holds the conversation any more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    aConversation();
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p-1', 'c-1');
    await vi.advanceTimersByTimeAsync(10);
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    await vi.advanceTimersByTimeAsync(10);
    expect(running()).toBe(true);

    wire.noRunNext();
    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 50);

    expect(running()).toBe(false);
  });

  it('is let go when the turn pauses on a questionnaire', async () => {
    const chat = aConversation();
    await attachTo();
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
    wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Two things first.' });
    wire.last()?.push({ type: 'text-end', id: 't1' });
    wire.last()?.push({
      type: 'tool-input-available',
      toolCallId: 'ask-1',
      toolName: 'ask_user',
      input: { questions: [] },
    });
    wire.last()?.push({ type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } });
    wire.last()?.push({ type: 'finish-step' });
    wire.last()?.push({ type: 'finish' });
    wire.last()?.close();
    await settle();

    // A pause, not a failure: the card is waiting on the user.
    expect(chat.status).toBe('ready');
    expect(
      chat.messages.at(-1)?.parts.some(
        (p) => (p as { toolCallId?: string; state?: string }).toolCallId === 'ask-1'
          && (p as { state?: string }).state === 'input-available',
      ),
    ).toBe(true);
    expect(running()).toBe(false);
  });
});

describe('a questionnaire answered on this page', () => {
  it('is held while the resumed turn runs and let go when it finishes', async () => {
    vi.mocked(chatApi.readConversation).mockResolvedValue({ conversation: { id: 'c-1' } as never, messages: structuredClone(PAUSED), hasMore: false });
    aConversation('c-1', structuredClone(PAUSED));
    chatLive.show('p-1', 'c-1');
    await settle();

    await answerTheCard();
    await settle();
    expect(running()).toBe(true);

    wire.last()?.push(BEAT);
    for (const chunk of replyEnds()) wire.last()?.push(chunk);
    wire.last()?.close();
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the answer is refused because the card was already answered elsewhere', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({
        status: 409,
        message: 'Already answered.',
        fromServer: true,
        details: { code: 409, call: { status: 'success', output: { repliedInChat: true } } },
      }),
    );
    const chat = aConversation('c-1', structuredClone(PAUSED));
    chatLive.show('p-1', 'c-1');
    await settle();

    await answerTheCard();
    await settle();

    // It did take that path: the card now shows what the server holds.
    expect(
      chat.messages.flatMap((m) => m.parts).find(
        (p) => (p as { toolCallId?: string }).toolCallId === 'ask-1',
      ),
    ).toMatchObject({ state: 'output-available', output: { repliedInChat: true } });
    expect(running()).toBe(false);
  });
});

describe('dropping sessions', () => {
  it('lets go of a conversation whose session is evicted mid-turn', async () => {
    aConversation();
    await attachTo();
    expect(running()).toBe(true);

    evictChatSession('c-1');

    // At once, not once the abandoned stream gets round to settling: the
    // session is gone, and nothing about it may outlive it.
    expect(running()).toBe(false);
  });

  it('lets go of every conversation when the project is left', async () => {
    aConversation('c-1');
    aConversation('c-2');
    await attachTo('c-1');
    noteTurnRunning('c-2');
    expect(running('c-1') && running('c-2')).toBe(true);

    evictAllChatSessions();

    // At once, as for one conversation.
    expect(useRunningTurns.getState().byConversation).toEqual({});
  });
});
