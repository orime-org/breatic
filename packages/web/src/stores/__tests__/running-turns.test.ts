// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which conversations have a turn running on this page (#1394).
 *
 * The conversation list marks them, so the store has to hold a conversation
 * for exactly as long as its turn runs: from the press to the turn's ending,
 * whichever way it ended. Every ending reaches `settleTurn`, and several of
 * them return early from it, so each is driven here through a real `Chat`
 * over a stubbed wire rather than by calling the store directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ChatApiModule from '@web/data/api/chat';
import type * as AssetsApiModule from '@web/data/api/assets';
import type { StoredUiMessage } from '@web/data/api/chat';
import { SSE_HEARTBEAT_MISSES_ALLOWED } from '@breatic/shared';

const BEAT_MS = 5000;

vi.mock('@web/data/api/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatApiModule>()),
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: BEAT_MS,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10,
      currentSpaceMaxChars: 100_000,
      spaceListMaxItems: 200,
      spaceReadTimeoutMs: 10_000,
      runningPollIntervalMs: 5000,
    })),
  },
}));

// Chat sends every body through bodyOrTransfer, which first asks for the
// upload config. Answered here so no request reaches the network, where fake
// timers would never settle it.
vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsApiModule>();
  return {
    ...actual,
    assetsApi: {
      ...actual.assetsApi,
      fetchUploadConfig: async () => ({
        maxUploadBytes: 2 * 1024 * 1024 * 1024,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        uploadIdleTimeoutMs: 30_000,
        assetUrlPrefix: 'https://assets.test.invalid/',
        uploadStatusPollSeconds: 5,
        maxRequestBodyBytes: 1048576,
      }),
    },
  };
});

import {
  answerInSession,
  chatSessionFor,
  evictAllChatSessions,
  evictChatSession,
  sendInSession,
  stopChatSession,
} from '@web/stores/chat-sessions';
import {
  clearRunningTurns,
  noteTurnRunning,
  noteTurnSettled,
  useRunningTurns,
} from '@web/stores/running-turns';
import { stubChatWire, stubRefusingWire, turnEnds, turnOpens } from '@web/test-utils/chat-wire';

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
    onFirstFrame: () => undefined,
  });
}

/**
 * Let every queued microtask run without moving the fake clock; enough of
 * them to carry a closed stream through to the turn's `onFinish`.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  evictAllChatSessions();
  clearRunningTurns();
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

describe('a turn sent on this page', () => {
  it('is held from the press, before anything comes back', async () => {
    stubChatWire();
    aConversation();

    void sendInSession('c-1', 'find references');
    await settle();

    expect(running()).toBe(true);
  });

  it('is let go once the reply finishes', async () => {
    const wire = stubChatWire();
    const chat = aConversation();
    void sendInSession('c-1', 'find references');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    wire.current()?.push({ type: 'text-delta', id: 't1', delta: 'Here.' });
    wire.current()?.push({ type: 'text-end', id: 't1' });
    await settle();
    expect(running()).toBe(true);

    for (const chunk of turnEnds()) wire.current()?.push(chunk);
    wire.current()?.close();
    await settle();

    expect(chat.status).toBe('ready');
    expect(running()).toBe(false);
  });

  it('is let go when the user stops it', async () => {
    const wire = stubChatWire();
    aConversation();
    void sendInSession('c-1', 'find references');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    await settle();
    expect(running()).toBe(true);

    stopChatSession('c-1');
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the reply fails partway', async () => {
    const wire = stubChatWire();
    const chat = aConversation();
    void sendInSession('c-1', 'find references');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    wire.current()?.push({ type: 'error', errorText: 'The turn could not be run.' });
    wire.current()?.close();
    await settle();

    expect(chat.status).toBe('error');
    expect(running()).toBe(false);
  });

  it('is let go when the server refuses it before any reply', async () => {
    stubRefusingWire(402, 'Not enough credits.');
    const chat = aConversation();

    await sendInSession('c-1', 'find references');
    await settle();

    expect(chat.status).toBe('error');
    expect(running()).toBe(false);
  });

  it('is let go when the request never reaches the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    aConversation();

    await sendInSession('c-1', 'find references');
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the stream goes silent and the page gives up on it', async () => {
    const wire = stubChatWire();
    aConversation();
    void sendInSession('c-1', 'find references');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    await settle();
    expect(running()).toBe(true);

    await vi.advanceTimersByTimeAsync(BEAT_MS * SSE_HEARTBEAT_MISSES_ALLOWED + 1);
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the turn pauses on a questionnaire', async () => {
    const wire = stubChatWire();
    const chat = aConversation();
    void sendInSession('c-1', 'make me a poster');
    await settle();
    for (const chunk of turnOpens()) wire.current()?.push(chunk);
    wire.current()?.push({ type: 'text-delta', id: 't1', delta: 'Two things first.' });
    wire.current()?.push({ type: 'text-end', id: 't1' });
    wire.current()?.push({
      type: 'tool-input-available',
      toolCallId: 'ask-1',
      toolName: 'ask_user',
      input: { questions: [] },
    });
    wire.current()?.push({ type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } });
    for (const chunk of turnEnds()) wire.current()?.push(chunk);
    wire.current()?.close();
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
    const wire = stubChatWire();
    aConversation('c-1', structuredClone(PAUSED));

    void answerInSession('c-1', 'ask-1', [{ index: 0, selected: ['9:16'] }]);
    await settle();
    expect(running()).toBe(true);

    wire.current()?.push({ type: 'tool-output-available', toolCallId: 'ask-1', output: { answers: [] } });
    for (const chunk of turnEnds()) wire.current()?.push(chunk);
    wire.current()?.close();
    await settle();

    expect(running()).toBe(false);
  });

  it('is let go when the answer is refused because the card was already answered elsewhere', async () => {
    // The one ending `settleTurn` returns from before it reaches the rest.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 409, message: 'Already answered.' },
              call: { status: 'success', output: { repliedInChat: true } },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    const chat = aConversation('c-1', structuredClone(PAUSED));

    await answerInSession('c-1', 'ask-1', [{ index: 0, selected: ['9:16'] }]);
    await settle();

    // It did take that path: the card now shows what the store holds.
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
    stubChatWire();
    aConversation();
    void sendInSession('c-1', 'find references');
    await settle();
    expect(running()).toBe(true);

    evictChatSession('c-1');

    // At once, not once the aborted turn gets round to settling: the session
    // is gone, and nothing about it may outlive it.
    expect(running()).toBe(false);
  });

  it('lets go of every conversation when the project is left', async () => {
    stubChatWire();
    aConversation('c-1');
    aConversation('c-2');
    void sendInSession('c-1', 'one');
    await settle();
    void sendInSession('c-2', 'two');
    await settle();
    expect(running('c-1') && running('c-2')).toBe(true);

    evictAllChatSessions();

    // At once, as for one conversation.
    expect(useRunningTurns.getState().byConversation).toEqual({});
  });
});
