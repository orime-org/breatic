// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What a conversation does when nobody is rendering it.
 *
 * The panel's own view of all this is covered where the panel is; what is
 * pinned here is the half that has no panel in it -- a turn that outlives the
 * one that started it, a project being left, a watchdog that has to stop
 * watching, and two writers appending to opposite ends of one list.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSE_EVENT_NAMES, SSE_HEARTBEAT_TIMEOUT_MS } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn(), messagesBefore: vi.fn() },
}));

import { chatApi } from '@web/data/api/chat';
import {
  conversationRuntime,
  useConversationRuntime,
  _resetForTests,
} from '@web/stores/conversation-runtime';

/** The stream handlers the store installed on its last send. */
let handlers: {
  onEvent: (e: SSEEventEnvelope) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
};

/**
 * Answer the open call with one conversation and one earlier turn.
 * @param opts - What the answer says
 * @param opts.hasMore - The conversation reaches back further than this page
 */
function openChatAnswers({ hasMore = false }: { hasMore?: boolean } = {}): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c-1' }],
    current: {
      conversation: { id: 'c-1' },
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'earlier' }],
          content: 'earlier',
          ts: '2026-08-13T00:00:00Z',
          turnIndex: 7,
        },
      ],
      hasMore,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * The conversation as the store holds it.
 * @returns Its runtime entry, or undefined once it has been dropped
 */
function conversation() {
  return useConversationRuntime.getState().conversations['c-1'];
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  vi.mocked(chatApi.streamMessage).mockImplementation((_input, h) => {
    handlers = h;
    // Never settles, the way the real call does not until the socket closes.
    // A mock that resolved the moment it was called would run the turn's own
    // cleanup immediately -- and that cleanup is what these cases are about.
    return new Promise<void>(() => {});
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a turn that nobody is rendering', () => {
  it('keeps going, and keeps writing into the conversation', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // No panel is involved in any of this. The pieces arrive and land.
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'half an ' } });
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'answer' } });

    expect(conversation()?.messages.at(-1)?.content).toBe('half an answer');
    expect(conversation()?.turn?.abort.signal.aborted).toBe(false);
  });
});

describe('leaving the project', () => {
  it('stops the turn and forgets the conversation', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    const { signal } = conversation()!.turn!.abort;

    conversationRuntime.leaveProject('p-1');

    // Stopped, not abandoned: once the project is off the screen there is no
    // stop button anywhere for this turn, so leaving it running would keep
    // the model going on the user's account with the switch out of reach.
    expect(signal.aborted).toBe(true);
    // And forgotten, because nothing keyed by conversation ever drops itself
    // -- the messages would sit in memory until the page closed, and loading
    // earlier lets a reader make that list as long as they like.
    expect(conversation()).toBeUndefined();
    expect(useConversationRuntime.getState().currentByProject['p-1']).toBeUndefined();
  });

  it('lets the project be opened again afterwards', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.leaveProject('p-1');

    await conversationRuntime.ensureLoaded('p-1');
    expect(conversation()?.messages).toHaveLength(1);
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
  });
});

describe('the watchdog that ends a silent turn', () => {
  it('ends the turn when the stream stops saying it is alive', async () => {
    vi.useFakeTimers();
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    vi.advanceTimersByTime(SSE_HEARTBEAT_TIMEOUT_MS + 1);

    // The same ending as pressing stop, because from here they are the same
    // fact: nothing more is coming. A dead socket produces no error and no
    // close, so without this the composer would stay disabled forever.
    expect(conversation()?.turn).toBeNull();
    expect(conversation()?.messages.at(-1)?.interrupted).toBe(true);
  });

  it('does not reach past the turn it was set for', async () => {
    vi.useFakeTimers();
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'first');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // The server says the turn is done. It has not closed the socket yet --
    // it still has the reply to write down and the turn to charge for -- but
    // the composer is already live again, so the reader sends the next one.
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'done' } });
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    expect(conversation()?.turn).toBeNull();

    // Almost as long as the first turn's watchdog will wait, so that the
    // second turn's own watchdog is still nowhere near due when it comes.
    vi.advanceTimersByTime(SSE_HEARTBEAT_TIMEOUT_MS - 1000);
    void conversationRuntime.send('p-1', 'second');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    const second = conversation()!.turn!;

    vi.advanceTimersByTime(1001);

    // The first turn's watchdog comes due in the middle of the second turn.
    // Left to stop "whatever is running", it would end a turn that is fine --
    // on behalf of one that finished perfectly well.
    expect(conversation()?.turn?.replyId).toBe(second.replyId);
    expect(second.abort.signal.aborted).toBe(false);
    expect(conversation()?.messages.find((m) => m.content === 'done')?.interrupted).toBeUndefined();
  });
});

describe('loading what came before', () => {
  it('puts it at the head, leaving the reply being written alone', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'grow' } });

    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [
        {
          id: 'm0',
          role: 'user',
          parts: [{ type: 'text', text: 'oldest' }],
          content: 'oldest',
          ts: '2026-08-12T00:00:00Z',
          turnIndex: 3,
        },
      ],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);

    await conversationRuntime.loadEarlier('c-1');
    // Asked from where the loaded history reaches back to, not from the
    // newest end: the cursor is the oldest turn on screen.
    expect(chatApi.messagesBefore).toHaveBeenCalledWith('c-1', 7);

    // Two writers, two ends. The reply keeps growing at the tail while the
    // older messages arrive at the head.
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'ing' } });

    expect(conversation()?.messages.map((m) => m.content)).toEqual([
      'oldest',
      'earlier',
      'hello',
      'growing',
    ]);
    expect(conversation()?.hasMore).toBe(false);
    expect(conversation()?.turn).not.toBeNull();
  });

  it('does nothing when there is nothing older', async () => {
    openChatAnswers({ hasMore: false });
    await conversationRuntime.ensureLoaded('p-1');

    await conversationRuntime.loadEarlier('c-1');

    expect(chatApi.messagesBefore).not.toHaveBeenCalled();
  });
});
