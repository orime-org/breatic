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
import { StreamDroppedError, StreamRefusedError, StreamUnreachableError } from '@web/data/stream/sse';
import { useChatStore } from '@web/stores/chat';
import {
  conversationRuntime,
  turnPhaseOf,
  useConversationRuntime,
  watchChatMishaps,
  _resetForTests,
} from '@web/stores/conversation-runtime';
import type { ChatMishap } from '@web/stores/conversation-runtime';

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
 * Say the turn has begun, which is the server's first word on every turn.
 *
 * Nothing of a turn is on screen before this arrives: the question is the
 * server's to hand back, and the reply has nowhere to be written yet. So the
 * cases below send this wherever they go on to assert about either.
 * @param texts - What the server says the conversation holds, oldest first
 * @param opts - What else the answer says
 * @param opts.firstTurnIndex - The turn the oldest of them belongs to
 * @param opts.hasMore - The conversation reaches back further than this page
 */
function turnStarts(
  texts: string[],
  { firstTurnIndex = 7, hasMore = false }: { firstTurnIndex?: number; hasMore?: boolean } = {},
): void {
  handlers.onEvent({
    event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
    data: {
      messages: texts.map((text, i) => ({
        id: `srv-${text}`,
        role: 'user',
        parts: [{ type: 'text', text }],
        content: text,
        ts: '2026-08-14T00:00:00Z',
        turnIndex: firstTurnIndex + i,
      })),
      hasMore,
    },
  } as unknown as SSEEventEnvelope);
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
  useChatStore.getState().reset();
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

describe('saying something when the chat has not opened', () => {
  it('opens one and runs the turn, rather than refusing', async () => {
    // The chat could not be opened when the project came up -- the network was
    // down, or the server was. Nothing about that stops the reader from typing
    // and pressing send, and pressing send is what should get them going.
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    openChatAnswers();
    // Not awaited to completion: a turn runs for as long as the stream is
    // open, and this one's stream stays open the way a real one does.
    void conversationRuntime.send('p-1', 'hello');
    // Waited for by the thing that only happens if this worked. `turn` is no
    // good to wait on here: until the conversation exists there is nothing to
    // read it off, and `undefined` passes a not-null check without meaning it.
    await vi.waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    // The conversation was opened on the way, and the turn is running in it.
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
    expect(chatApi.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c-1', message: 'hello' }),
      expect.anything(),
    );
    expect(conversation()?.turn).not.toBeNull();
  });

  it('says so once when it cannot be opened either, and leaves the screen alone', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));
    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));

    await conversationRuntime.send('p-1', 'hello');
    stop();

    // One line, and nothing else happens: no turn, nothing written anywhere,
    // and the words are still in the box because nothing took them out of it.
    expect(told).toEqual([{ projectId: 'p-1', conversationId: null, kind: 'network' }]);
    expect(chatApi.streamMessage).not.toHaveBeenCalled();
  });
});

describe('pressing send twice while the conversation is still being opened', () => {
  it('runs one turn, not two', async () => {
    // The first press has to open a conversation before it can send anything,
    // and that is a whole request. The reader sees nothing move and presses
    // again -- which is what people do.
    let openIt: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        openIt = resolve;
      }),
    );

    void conversationRuntime.send('p-1', 'hello');
    void conversationRuntime.send('p-1', 'hello');
    openIt({
      conversations: [{ id: 'c-1' }],
      current: { conversation: { id: 'c-1' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    await vi.waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());

    // Two turns would store the same sentence twice, ask the model twice and
    // charge for both -- and the first of them would be invisible: its turn is
    // overwritten by the second, so nothing on screen can stop it.
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(1);
  });

  it('is already waiting from the press, not from the conversation', async () => {
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));

    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());

    // What the panel renders as the waiting indicator reads this. Left until
    // the conversation exists, the whole opening request is a window with a
    // live send button on it.
    expect(turnPhaseOf(useConversationRuntime.getState(), 'p-1')).toBe('sending');
  });
});

describe('a conversation the server no longer has', () => {
  it('is still one send, while the next one is being opened', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    // The first attempt is refused: another tab deleted this conversation.
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found'));
    });
    // Opening the replacement takes a request, and that request hangs.
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));

    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));

    // This is the same gap as the one before the first turn: no turn exists
    // and a conversation is being opened. Pressing send again here runs the
    // sentence a second time, on a conversation the first press is about to
    // adopt.
    void conversationRuntime.send('p-1', 'hello');
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(1);
  });
});

describe('the box the words were typed into', () => {
  it('is emptied by the conversation, not by whoever is rendering it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    useChatStore.getState().setComposerDraft('  hello  ');

    void conversationRuntime.send('p-1', '  hello  ');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // Still in the box: nothing has said the server has it.
    expect(useChatStore.getState().composerDraft).toBe('  hello  ');
    // And what went out is the trimmed message, not the whitespace.
    expect(chatApi.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hello' }),
      expect.anything(),
    );

    turnStarts(['earlier', 'hello']);

    // Emptied here, by the store. The panel showing this conversation may have
    // been collapsed the moment after the press -- that is a thing readers do,
    // and this turn goes on without it -- so a rule that lives in the panel is
    // a rule that stops running exactly when someone walks away from it.
    expect(useChatStore.getState().composerDraft).toBe('');
  });

  it('keeps everything when the reader carried on typing', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    useChatStore.getState().setComposerDraft('hello');

    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    // Carrying on typing is the ordinary thing to do; nothing stops them.
    useChatStore.getState().setComposerDraft('hello and one more thing');

    turnStarts(['earlier', 'hello']);

    // Cutting the front off would be right here and wrong in the sibling case
    // below, and nothing in the text says which one this is. So the box keeps
    // what it has: a sent line left in it is one the reader can delete, and
    // deleting it is not something this end can get wrong.
    expect(useChatStore.getState().composerDraft).toBe('hello and one more thing');
  });
});

describe('what the box is left holding', () => {
  it('is left alone once the reader has touched it at all', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    useChatStore.getState().setComposerDraft('ok');

    void conversationRuntime.send('p-1', 'ok');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    // Cleared it and started the next sentence, which happens to begin with
    // the same two letters -- as short openings do.
    useChatStore.getState().setComposerDraft('ok, now make it blue');

    turnStarts(['earlier', 'ok']);

    // Nothing in the box is ours to take once it has been edited: no rule
    // written on the text can tell "our words are still there" from "what
    // they typed happens to look like them", and every rule that tries takes
    // letters off the front of a sentence they are still writing.
    expect(useChatStore.getState().composerDraft).toBe('ok, now make it blue');
  });

  it('is left alone when what is in it is not what went out', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    useChatStore.getState().setComposerDraft('hi');

    void conversationRuntime.send('p-1', 'hi');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    // They cleared the box and started something else while waiting. It
    // happens to contain those two letters, which is not the same as being
    // the words that went out.
    useChatStore.getState().setComposerDraft('This is the next one');

    turnStarts(['earlier', 'hi']);

    // Taking out the first thing that looks the same would leave them holding
    // "Ts is the next one" -- rewritten in front of them, with nothing said
    // and no way back.
    expect(useChatStore.getState().composerDraft).toBe('This is the next one');
  });
});

describe('a turn the server gives up on', () => {
  it('says so, even when it fails before the conversation comes back', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    // The server stored nothing and hands back nothing: the failure arrives
    // before the event that would have put this turn on screen.
    handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'internal' } });
    stop();

    // There is no bubble to mark -- the reply has not been made yet -- so a
    // mark on a message is not a way of saying this. Without a word here the
    // reader watches the waiting indicator stop and nothing else happen.
    expect(told).toEqual([{ projectId: 'p-1', conversationId: 'c-1', kind: 'turn' }]);
    expect(conversation()?.turn).toBeNull();
  });
});

describe('a turn that nobody is rendering', () => {
  it('keeps going, and keeps writing into the conversation', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // No panel is involved in any of this. The pieces arrive and land.
    turnStarts(['earlier', 'hello']);
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
    turnStarts(['earlier', 'hello']);

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
    turnStarts(['earlier', 'first']);
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
    turnStarts(['earlier', 'hello'], { hasMore: true });
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

  it('drops a page that no longer joins onto the list', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');

    let landPage: (p: Awaited<ReturnType<typeof chatApi.messagesBefore>>) => void = () => {};
    vi.mocked(chatApi.messagesBefore).mockReturnValueOnce(
      new Promise((resolve) => {
        landPage = resolve;
      }),
    );
    // Asked from turn 7, which is where the list reached back to.
    const earlier = conversationRuntime.loadEarlier('c-1');

    // Before it answers, the reader sends something and the turn opens by
    // handing back the server's own page -- which starts at turn 60.
    void conversationRuntime.send('p-1', 'a new question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    turnStarts(['much later', 'a new question'], { firstTurnIndex: 60, hasMore: true });

    landPage({
      messages: [
        {
          id: 'm5',
          role: 'user',
          parts: [{ type: 'text', text: 'turn five' }],
          content: 'turn five',
          ts: '2026-08-01T00:00:00Z',
          turnIndex: 5,
        },
      ],
      hasMore: true,
    } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>);
    await earlier;

    // This page was asked for from a list that no longer exists. Putting it at
    // the head of the new one leaves turns 8 to 59 missing with nothing on
    // screen saying so -- and moves the cursor past them, so no press could
    // ever ask for them again.
    expect(conversation()?.messages.map((m) => m.content)).toEqual([
      'much later',
      'a new question',
      '',
    ]);
    expect(conversation()?.oldestLoadedTurn).toBe(60);
  });

  it('asks again when the list has moved on, rather than joining the old request', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');

    // The first page, asked for from turn 7, never answers. The second is
    // answered, so what is being watched is whether a second one is made.
    vi.mocked(chatApi.messagesBefore).mockImplementation((_id, beforeTurn) =>
      beforeTurn === 7
        ? new Promise(() => {})
        : Promise.resolve({
          messages: [
            {
              id: 'm59',
              role: 'user',
              parts: [{ type: 'text', text: 'turn fifty-nine' }],
              content: 'turn fifty-nine',
              ts: '2026-08-13T00:00:00Z',
              turnIndex: 59,
            },
          ],
          hasMore: true,
        } as unknown as Awaited<ReturnType<typeof chatApi.messagesBefore>>),
    );
    void conversationRuntime.loadEarlier('c-1');

    // A turn begins and hands back the server's own page, which starts at 60.
    void conversationRuntime.send('p-1', 'a new question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    turnStarts(['much later', 'a new question'], { firstTurnIndex: 60, hasMore: true });

    void conversationRuntime.loadEarlier('c-1');

    // Joining the one still on its way would be waiting on an answer that is
    // going to be dropped -- it was asked from a list that no longer exists.
    // The reader pressed a button and nothing at all would happen.
    await vi.waitFor(() => expect(chatApi.messagesBefore).toHaveBeenCalledTimes(2));
    expect(chatApi.messagesBefore).toHaveBeenLastCalledWith('c-1', 60, expect.any(AbortSignal));
    expect(conversation()?.messages.map((m) => m.content)).toEqual([
      'turn fifty-nine',
      'much later',
      'a new question',
      '',
    ]);
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

describe('a turn that begins by settling up', () => {
  it('puts nothing on screen until the server says it has the message', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'a new question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // The request is out and nothing else has happened. Nothing the browser
    // made up is on screen: not the question, which the server may yet refuse
    // to store, and not an empty reply, which nothing is writing to.
    expect(conversation()?.messages.map((m) => m.content)).toEqual(['earlier']);
    expect(conversation()?.turn?.started).toBe(false);

    turnStarts(['earlier', 'a new question']);

    // Now there is a turn to show: the conversation as the server has it, and
    // one empty place at the end for the reply to be written into.
    expect(conversation()?.turn?.started).toBe(true);
    expect(conversation()?.messages.map((m) => m.content)).toEqual([
      'earlier',
      'a new question',
      '',
    ]);
    expect(conversation()?.messages.at(-1)?.id).toBe(conversation()?.turn?.replyId);
    expect(conversation()?.messages.at(-1)?.streaming).toBe(true);
  });

  it('leaves nothing behind when the server refuses to take the message', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'a new question').catch(() => undefined);
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    handlers.onError?.(new StreamRefusedError(402, 'You are out of credits.'));
    await vi.waitFor(() => expect(conversation()?.turn).toBeNull());

    // Nothing to take back: the browser never wrote the question down, so a
    // refusal leaves the conversation exactly as it was.
    expect(conversation()?.messages.map((m) => m.content)).toEqual(['earlier']);
  });

  it('takes the server\'s conversation whole, and writes the reply onto the end', async () => {
    openChatAnswers({ hasMore: false });
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'a new question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    turnStarts(['earlier', 'a new question'], { hasMore: true });

    // Everything before the reply is the server's own record and nothing else.
    // Keeping any of the browser's version would be keeping exactly the part
    // that might be wrong -- a reply the server never stored, or one it
    // stored while this end stopped hearing about it.
    expect(conversation()?.messages.map((m) => m.id)).toEqual([
      'srv-earlier',
      'srv-a new question',
      conversation()?.turn?.replyId,
    ]);
    // And the reply grows on the end, because it is the one thing the server
    // could not have sent: it has not been written down yet.
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'the rep' } });
    handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'ly' } });
    expect(conversation()?.messages.at(-1)?.content).toBe('the reply');
    expect(conversation()?.turn).not.toBeNull();
  });

  it('resets how far back the list reaches, so the cursor matches the list', async () => {
    openChatAnswers({ hasMore: false });
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'a new question');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    handlers.onEvent({
      event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
      data: {
        messages: [
          {
            id: 'srv-new',
            role: 'user',
            parts: [{ type: 'text', text: 'a new question' }],
            content: 'a new question',
            ts: '2026-08-14T00:00:00Z',
            turnIndex: 40,
          },
        ],
        hasMore: true,
      },
    });

    // The list was replaced, so what the reader had pulled up from further
    // back is gone -- and the cursor has to say so, or the next press would
    // ask from a turn that is no longer on screen and leave a hole.
    expect(conversation()?.hasMore).toBe(true);
    expect(conversation()?.oldestLoadedTurn).toBe(40);
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
    turnStarts(['hello again', 'my question'], { firstTurnIndex: 40 });
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

  it('does not take the next visit\'s request off the books when it lands', async () => {
    let landFirstVisit: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        landFirstVisit = resolve;
      }),
    );
    const firstVisit = conversationRuntime.ensureLoaded('p-1');

    conversationRuntime.leaveProject('p-1');
    // The second visit's request never answers, so it stays on the books for
    // as long as it is running -- which is what a second caller joins.
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));
    void conversationRuntime.ensureLoaded('p-1');

    landFirstVisit(answer(['hello again']));
    await firstVisit;

    // The first visit's request is over and takes itself off the books. Taking
    // the entry off by name takes off whatever is there, which by now is the
    // second visit's -- and the next caller, finding nothing, asks the server
    // all over again for something already on its way. Not awaited: joining
    // the request still running is the whole point, and it does not answer.
    void conversationRuntime.ensureLoaded('p-1');
    expect(chatApi.openChat).toHaveBeenCalledTimes(2);
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

describe('telling the reader that something went wrong', () => {
  /**
   * Collect every mishap told while the given work runs.
   * @param work - Run with a watcher attached.
   * @returns What it was told, in order.
   */
  async function whatIsTold(work: () => Promise<void> | void): Promise<ChatMishap[]> {
    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await work();
    stop();
    return told;
  }

  it('calls it a network error when no answer came back at all', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told = await whatIsTold(async () => {
      void conversationRuntime.send('p-1', 'hello');
      await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
      turnStarts(['earlier', 'hello']);
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'half an ans' } });
      handlers.onError?.(new StreamDroppedError(new Error('socket died')));
    });

    // The reply keeps the same mark pressing stop leaves -- the server cannot
    // tell those apart either. What the reader gets is one line, once.
    expect(conversation()?.messages.at(-1)?.interrupted).toBe(true);
    expect(told).toEqual([{ projectId: 'p-1', conversationId: 'c-1', kind: 'network' }]);
  });

  it('passes on what the server said, when the server answered', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told = await whatIsTold(async () => {
      void conversationRuntime.send('p-1', 'hello').catch(() => undefined);
      await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
      handlers.onError?.(new StreamRefusedError(402, 'You are out of credits.'));
      await vi.waitFor(() => expect(conversation()?.turn).toBeNull());
    });

    // Getting an answer at all means the network was fine, so this is not a
    // network error -- and the server wrote the only sentence anyone wrote
    // about it, in the reader's own language.
    expect(told).toEqual([
      { projectId: 'p-1', conversationId: 'c-1', kind: 'server', message: 'You are out of credits.' },
    ]);
  });

  it('calls it a network error when the request never left', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told = await whatIsTold(async () => {
      void conversationRuntime.send('p-1', 'hello').catch(() => undefined);
      await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
      handlers.onError?.(new StreamUnreachableError(new Error('offline')));
      await vi.waitFor(() => expect(conversation()?.turn).toBeNull());
    });

    expect(told).toEqual([{ projectId: 'p-1', conversationId: 'c-1', kind: 'network' }]);
  });

  it('says nothing at all when the user was the one who stopped it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told = await whatIsTold(async () => {
      void conversationRuntime.send('p-1', 'hello');
      await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
      turnStarts(['earlier', 'hello']);
      conversationRuntime.stopTurn('c-1');
    });

    // Pressing stop is the reader doing it on purpose. Nobody needs telling
    // about what they just did.
    expect(conversation()?.messages.at(-1)?.interrupted).toBe(true);
    expect(told).toEqual([]);
  });

  it('says nothing at all when the reader left the project', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told = await whatIsTold(async () => {
      void conversationRuntime.send('p-1', 'hello');
      await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
      conversationRuntime.leaveProject('p-1');
    });

    // Leaving closes every connection this project had, which is the reader
    // disconnecting on purpose -- the same as pressing stop, and told the
    // same way: not at all.
    expect(told).toEqual([]);
  });

  it('is dropped when nobody is watching, rather than kept for later', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // Nothing is watching: the panel is collapsed, or the reader is looking
    // at another conversation.
    handlers.onError?.(new StreamDroppedError(new Error('socket died')));

    // Attaching now is a reader coming back, and they are told nothing --
    // what they see is a conversation that stopped moving, which is how they
    // know. There is no state anywhere holding the news for them.
    const told = await whatIsTold(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(told).toEqual([]);
  });

  it('calls a page it could not reach back for a network error too', async () => {
    openChatAnswers({ hasMore: true });
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.messagesBefore).mockRejectedValueOnce(new Error('blip'));

    const told = await whatIsTold(() => conversationRuntime.loadEarlier('c-1'));

    expect(told).toEqual([{ projectId: 'p-1', conversationId: 'c-1', kind: 'network' }]);
    // Still offering, because the reader may simply press it again.
    expect(conversation()?.hasMore).toBe(true);
  });
});
