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
import { StreamDroppedError } from '@web/data/stream/sse';
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
    expect(chatApi.messagesBefore).toHaveBeenCalledWith('c-1', 7, expect.any(AbortSignal));

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

  it('fetches one page however many times the button is pressed', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
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

    // Both before either lands, which is what a second press is.
    await Promise.all([
      conversationRuntime.loadEarlier('c-1'),
      conversationRuntime.loadEarlier('c-1'),
    ]);

    // Two requests would answer with the same page and both would write it to
    // the head, so the reader would be shown every earlier message twice.
    expect(chatApi.messagesBefore).toHaveBeenCalledTimes(1);
    expect(conversation()?.messages.map((m) => m.content)).toEqual(['oldest', 'earlier']);
  });

  it('says so when it fails, rather than rejecting into a click handler', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockRejectedValue(new Error('offline'));

    // Not `.rejects`: the caller is an onClick, and a rejection out of one is
    // an unhandled rejection with nobody to catch it.
    await expect(conversationRuntime.loadEarlier('c-1')).resolves.toBeUndefined();

    expect(conversation()?.earlierFailed).toBe(true);
    // Still there, still saying there is more -- the button the reader
    // pressed is the way to press it again.
    expect(conversation()?.hasMore).toBe(true);
  });

  it('stops saying it failed once the reader presses again', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.loadEarlier('c-1');
    expect(conversation()?.earlierFailed).toBe(true);

    vi.mocked(chatApi.messagesBefore).mockResolvedValue({
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await conversationRuntime.loadEarlier('c-1');

    expect(conversation()?.earlierFailed).toBe(false);
  });
});

describe('an answer that arrives after the reader has left', () => {
  it('is dropped, rather than putting the project back', async () => {
    let answer: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const opened = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    answer({
      conversations: [{ id: 'c-1' }],
      current: { conversation: { id: 'c-1' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    await opened;

    // Nothing clears these a second time: leaving already ran, and it is the
    // only thing that clears them. Written now, they would stay for the life
    // of the page -- a conversation for a project nobody is looking at.
    expect(conversation()).toBeUndefined();
    expect(useConversationRuntime.getState().currentByProject['p-1']).toBeUndefined();
    expect(useConversationRuntime.getState().openStatus['p-1']).toBeUndefined();
  });

  it('is dropped when it is a refusal too', async () => {
    let refuse: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }) as ReturnType<typeof chatApi.openChat>,
    );
    const opened = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    refuse(new Error('gone'));
    await opened;

    // Otherwise the project comes back holding one thing: the news that it
    // failed, about a request made for a screen that is no longer there.
    expect(useConversationRuntime.getState().openStatus['p-1']).toBeUndefined();
  });
});

describe('a request left over from a previous visit to the project', () => {
  /**
   * Answer the open call with one conversation holding the given messages.
   * @param texts - What has been said in it, oldest first
   * @param hasMore - The conversation reaches back further than this page
   * @returns That answer, in the shape the api hands out
   */
  function answer(texts: string[], hasMore = false): Awaited<ReturnType<typeof chatApi.openChat>> {
    return {
      conversations: [{ id: 'c-1' }],
      current: {
        conversation: { id: 'c-1' },
        messages: texts.map((text, i) => ({
          id: `srv-${text}`,
          role: 'user',
          parts: [{ type: 'text', text }],
          content: text,
          ts: '2026-08-13T00:00:00Z',
          turnIndex: 40 + i,
        })),
        hasMore,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>;
  }

  it('does not land on the turn the next visit is running', async () => {
    let landFirstVisit: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        landFirstVisit = resolve;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    // Slow to open, which is the reason the reader backs out and comes in
    // again -- so this is not an unusual sequence, it is the usual answer to
    // a project that is taking too long.
    conversationRuntime.leaveProject('p-1');
    vi.mocked(chatApi.openChat).mockResolvedValueOnce(answer(['hello again']));
    await conversationRuntime.ensureLoaded('p-1');

    void conversationRuntime.send('p-1', 'my question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    const running = conversation()!.turn!;
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'half an answer' } });

    landFirstVisit(answer(['hello again']));
    await firstVisit;

    // Adopting rebuilds the conversation from scratch, turn and all. Landing
    // it here takes the running turn out of the only place anything can reach
    // it: the stop button goes, and nothing else stops a turn -- so the model
    // keeps going on the reader's account with the switch gone.
    expect(conversation()?.turn?.replyId).toBe(running.replyId);
    expect(conversation()?.messages.map((m) => m.content)).toContain('my question');
    expect(conversation()?.messages.at(-1)?.content).toBe('half an answer');
  });

  it('does not turn a chat that is open and being read into one that failed', async () => {
    let refuseFirstVisit: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        refuseFirstVisit = reject;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    vi.mocked(chatApi.openChat).mockResolvedValueOnce(answer(['readable history']));
    await conversationRuntime.ensureLoaded('p-1');

    refuseFirstVisit(new Error('timed out'));
    await firstVisit;

    // Otherwise the conversation on screen is replaced by an empty column
    // saying the chat could not be opened -- about a request made for a
    // screen the reader already left.
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');
  });

  it('does not leave a hole in the middle of the message column', async () => {
    vi.mocked(chatApi.openChat).mockResolvedValue(answer(['newest'], true));
    await conversationRuntime.ensureLoaded('p-1');

    let landPage: (p: Awaited<ReturnType<typeof chatApi.messagesBefore>>) => void = () => {};
    vi.mocked(chatApi.messagesBefore).mockReturnValueOnce(
      new Promise((resolve) => {
        landPage = resolve;
      }),
    );
    const earlier = conversationRuntime.loadEarlier('c-1');

    conversationRuntime.leaveProject('p-1');
    await conversationRuntime.ensureLoaded('p-1');

    landPage({
      messages: [
        {
          id: 'old',
          role: 'user',
          parts: [{ type: 'text', text: 'turn ten' }],
          content: 'turn ten',
          ts: '2026-08-01T00:00:00Z',
          turnIndex: 10,
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await earlier;

    // The page was asked for from where the previous visit had read back to.
    // Written onto the newest page the new visit adopted, it puts turn 10
    // directly above turn 40 with nothing on screen saying what is missing --
    // and moves the cursor past the gap, so no press can ever ask for it.
    expect(conversation()?.messages.map((m) => m.content)).toEqual(['newest']);
    expect(conversation()?.oldestLoadedTurn).toBe(40);
  });
});

describe('opening again after it failed', () => {
  it('asks again, which is what the retry button does', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');
    expect(conversation()?.messages).toHaveLength(1);
  });
});

describe('a turn that ended because the connection did', () => {
  it('says so, because from the reply alone it looks like the user stopped it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'half an ans' } });

    handlers.onError?.(new StreamDroppedError(new Error('socket died')));

    // The mark on the reply is the same one pressing stop leaves, and it has
    // to be: the server cannot tell the two apart either, and records both as
    // stopped. What the reader is owed is the difference -- their answer was
    // cut off by the connection, not by them.
    expect(conversation()?.messages.at(-1)?.interrupted).toBe(true);
    expect(conversation()?.connectionLost).toBe(true);
  });

  it('stops saying it once a new turn is under way', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    handlers.onError?.(new StreamDroppedError(new Error('socket died')));
    expect(conversation()?.connectionLost).toBe(true);

    void conversationRuntime.send('p-1', 'again');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // Trying again is what makes the last failure old news. A line still
    // saying the connection is gone, over a reply arriving, is worse than no
    // line at all.
    expect(conversation()?.connectionLost).toBe(false);
  });

  it('is not left standing in front of a later turn that dropped', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockRejectedValueOnce(new Error('blip'));
    await conversationRuntime.loadEarlier('c-1');
    expect(conversation()?.earlierFailed).toBe(true);

    // The reader moves on and sends something. Whatever failed before that is
    // no longer what is happening -- and the panel has one line to say things
    // in, which this would otherwise hold for the rest of the conversation.
    void conversationRuntime.send('p-1', 'never mind, carry on');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    expect(conversation()?.earlierFailed).toBe(false);
  });

  it('says nothing when the user was the one who stopped it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    conversationRuntime.stopTurn('c-1');

    expect(conversation()?.messages.at(-1)?.interrupted).toBe(true);
    expect(conversation()?.connectionLost).toBe(false);
  });
});
