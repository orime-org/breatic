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
import { ApiException } from '@web/data/api/types';
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
  {
    firstTurnIndex = 7,
    hasMore = false,
    title = null,
  }: { firstTurnIndex?: number; hasMore?: boolean; title?: string | null } = {},
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
      title,
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
    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: null, kind: 'network' })]);
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
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
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

describe('what the message column is told while a chat is re-opened', () => {
  it('says it is trying again when a chat that could not be read is re-opened', async () => {
    // 打开失败之后,屏幕上没有会话 —— 蒙版盖着整列。所以再打开一次不会
    // 拿走任何东西,而说一句「在读了」正是重试该有的样子:蒙版让位给等待,
    // 再失败一次蒙版再回来。
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('failed');

    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));
    void conversationRuntime.ensureLoaded('p-1');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));

    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('loading');
  });

  it('keeps a chat that opened once from being called unopenable later', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');

    // The conversation is gone, so the turn is refused and a replacement is
    // opened -- and that open fails too, with the reader still looking at the
    // messages the first one brought.
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    await conversationRuntime.send('p-1', 'hello');

    // Saying it could not be opened would take those messages off the screen
    // over a request the reader never made.
    expect(useConversationRuntime.getState().openStatus['p-1']).toBe('ready');
    expect(conversation()?.messages.map((m) => m.content)).toEqual(['earlier']);
  });
});

describe('one press, one line', () => {
  /**
   * Open a chat, then set the next turn up to be refused.
   *
   * The refusal is the caller's to choose, and it is the only one queued --
   * a helper that queued one of its own would leave it behind for whichever
   * case runs next when a test only sends once.
   * @param refusal - How the server answers the turn. Defaults to the one
   *   refusal worth retrying: the conversation on screen has been deleted
   *   from another tab, which is what this whole recovery exists for.
   */
  async function theConversationIsGone(
    refusal: StreamRefusedError = new StreamRefusedError(404, 'Resource not found', true),
  ): Promise<void> {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(refusal);
    });
  }

  it('says nothing when the words went out on a replacement instead', async () => {
    await theConversationIsGone();
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-2' }],
      current: { conversation: { id: 'c-2' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalledTimes(2));
    stop();

    // The reader pressed send and their words went to the server. Nothing
    // about that needs a line -- what the first attempt hit was ours to
    // recover from, and we did.
    expect(told).toEqual([]);
    expect(chatApi.streamMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'c-2', message: 'hello' }),
      expect.anything(),
    );
  });

  it('says it once when the replacement is refused too, rather than nothing at all', async () => {
    // The replacement opens, the words go out on it, and it is refused as
    // well -- another tab deleting this one too, or a route that answers 404
    // whatever is asked of it. Nobody tries a third time, so this is the
    // attempt that ran out of options and the one that owes the reader a line.
    await theConversationIsGone();
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-2' }],
      current: { conversation: { id: 'c-2' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    // Every send is refused, the first one included.
    vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    expect(told).toHaveLength(1);
  });

  it('does not re-send the words on a 404 nobody of ours wrote', async () => {
    // A proxy or gateway answering 404 for an unrouted path looks identical
    // here to our own "that conversation is gone" -- unless the refusal is
    // asked where its message came from. Opening a replacement and putting
    // the reader's words on it is not something to do on a status no part of
    // our server produced.
    await theConversationIsGone(new StreamRefusedError(404, 'Not Found', false));
    vi.mocked(chatApi.openChat).mockClear();

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    expect(chatApi.openChat).not.toHaveBeenCalled();
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(1);
    expect(told).toHaveLength(1);
  });

  it('says it once per failed request, however many callers were waiting on it', async () => {
    // The panel asks for the chat when it mounts. The reader types and
    // presses send before that lands, and the send asks for the same thing --
    // which joins the request already out rather than making a second one.
    // One request fails; one line is owed.
    let refuse: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((_res, rej) => {
        refuse = rej;
      }),
    );
    const mounting = conversationRuntime.ensureLoaded('p-1');

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    const sending = conversationRuntime.send('p-1', 'hello');
    refuse(new Error('offline'));
    await mounting;
    await sending;
    stop();

    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(told).toHaveLength(1);
  });

  it('says nothing to a visit the reader has already left', async () => {
    // Opening the replacement is a whole request, and the reader can walk out
    // of the project during it. What comes back then is news about a
    // conversation from a visit that is over -- and the panel of the visit
    // they are on now is the one watching.
    await theConversationIsGone();
    // Held open, then refused the way an aborted request really is refused.
    let giveUp: (e: unknown) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((_res, rej) => {
        giveUp = rej;
      }),
    );

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    const sending = conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));

    conversationRuntime.leaveProject('p-1');
    giveUp(new DOMException('aborted', 'AbortError'));
    await sending;
    stop();

    expect(told).toEqual([]);
  });

  it('says it once, not twice, when there is no replacement to be had', async () => {
    // 404 is also what a project answers once the reader has been taken off
    // it, or once it is gone -- and then opening a replacement asks the same
    // question of the same project and gets the same answer.
    await theConversationIsGone();
    vi.mocked(chatApi.openChat).mockRejectedValue(
      new ApiException({ status: 404, message: '未找到', fromServer: true }),
    );

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    // Two lines is one press announced twice: the panel keys the line by
    // which telling it is, so the second tears the first down and puts an
    // identical one up, and a screen reader reads it out again.
    expect(told).toHaveLength(1);
    // And it is the newer of the two answers. Both are ours and they say
    // different things: the first is about the conversation this press went
    // looking for, the second about the project the reader has just been
    // taken off. Quoting the first would send them after a conversation when
    // the news is that the project is no longer theirs.
    expect(told[0]).toMatchObject({ kind: 'server', message: '未找到' });
  });
});

describe('a turn that fails with its reply already on screen', () => {
  it('lets the bubble say it, rather than saying it twice', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    // The turn started, so the reply is on screen and can carry the mark.
    turnStarts(['earlier', 'hello']);
    handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'upstream' } });
    stop();

    // The bubble renders the same sentence the line would. Two of them is one
    // failure announced twice, and two alerts for a screen reader.
    expect(conversation()?.messages.at(-1)?.failed).toBe(true);
    expect(told).toEqual([]);
  });
});

describe('an answer that did not come from our server', () => {
  it('is not passed off as a sentence written for the reader', async () => {
    // A gateway timing out answers with its own body, so there is no message
    // of ours in it -- what the library leaves behind is English written for
    // a developer, and it has never been through `t()`.
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(
      new ApiException({ status: 502, message: 'Request failed with status code 502' }),
    );

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.ensureLoaded('p-1');
    stop();

    expect(told).toEqual([
      expect.objectContaining({ projectId: 'p-1', conversationId: null, kind: 'network' }),
    ]);
  });

  it('is not called a network error either, because something did answer', async () => {
    // The same gateway, one layer over: the stream was refused before it
    // opened and there was no sentence of ours in the body, so the transport
    // filled the refusal with its own generic one. Two things are true and
    // the reader is owed both: it is not a sentence our server wrote, and the
    // network was fine -- something answered. What is left to say is the only
    // thing that holds: this reply is not coming, send it again.
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(502, 'Internal server error', false));
    });

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', kind: 'turn' })]);
  });

  it('is still a network error when nothing answered at all', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamUnreachableError(new Error('offline')));
    });

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    expect(told).toEqual([expect.objectContaining({ kind: 'network' })]);
  });

  it('still passes on the one the server did write', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(402, '积分不足', true));
    });

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    await conversationRuntime.send('p-1', 'hello');
    stop();

    expect(told).toEqual([
      expect.objectContaining({ kind: 'server', message: '积分不足' }),
    ]);
  });
});

describe('the box the words were typed into', () => {
  it('is emptied by the conversation, not by whoever is rendering it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.setDraft('p-1', 'c-1', '  hello  ');

    void conversationRuntime.send('p-1', '  hello  ');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    // Still in the box: nothing has said the server has it.
    expect(conversationRuntime.draftOf('p-1', 'c-1')).toBe('  hello  ');
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
    expect(conversationRuntime.draftOf('p-1', 'c-1')).toBe('');
  });

  it('is emptied whatever it happens to hold, because only one thing can be in it', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.setDraft('p-1', 'c-1', 'hello');

    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());

    turnStarts(['earlier', 'hello']);

    // No rule is applied to the text and none is needed. The box takes
    // nothing between the press and this event, so there is nothing of the
    // reader's own in there for a rule to get wrong. Three were tried --
    // exact, contains, starts-with -- before it was clear the question only
    // exists if the box accepts input while it is showing something it did
    // not get from them.
    expect(conversationRuntime.draftOf('p-1', 'c-1')).toBe('');
  });

  it('empties only the conversation the turn belongs to', async () => {
    // A draft belongs to a conversation. Another one holding a half-typed
    // sentence is not affected by this turn landing in this one.
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.setDraft('p-1', 'c-1', 'hello');
    conversationRuntime.setDraft('p-1', 'c-2', 'typed somewhere else');

    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    turnStarts(['hello']);

    expect(conversationRuntime.draftOf('p-1', 'c-1')).toBe('');
    expect(conversationRuntime.draftOf('p-1', 'c-2')).toBe('typed somewhere else');
  });

  it('takes the name the server gives the conversation on that same event', async () => {
    // The turn that says the message landed is also the turn that named the
    // conversation, when it was the first one. Nothing else on this stream
    // ever mentions the name.
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');

    void conversationRuntime.send('p-1', 'find me a reference');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    turnStarts(['find me a reference'], { title: 'find me a reference' });

    const listed = useConversationRuntime.getState().listByProject['p-1'];
    expect(listed?.[0]?.title).toBe('find me a reference');
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
    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'turn' })]);
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

describe('an error that arrives after the turn it belongs to has ended', () => {
  /**
   * Run one turn to its end, start a second, and hand back the first one's.
   *
   * The socket closing is what ends a turn, and the transport can report the
   * failure that closed it afterwards -- so the first turn's handlers outlive
   * it. The second turn has to be under way for this to be worth guarding: a
   * conversation running nothing is one every check turns away anyway, and
   * what these cases are about is a late ending landing on the turn that came
   * after it. Its own first event has not arrived yet, which is why the reply
   * the first turn wrote is still the last one on the list.
   * @returns The handlers of the turn that has ended, and its reply's id.
   */
  async function aLateEnding(): Promise<{ ended: typeof handlers; itsReplyId: string }> {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    void conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    turnStarts(['earlier', 'hello']);

    const ended = handlers;
    const itsReplyId = conversation()?.messages.at(-1)?.id ?? '';
    ended.onClose?.();
    expect(conversation()?.turn).toBeNull();

    void conversationRuntime.send('p-1', 'and another');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    expect(conversation()?.turn?.replyId).not.toBe(itsReplyId);

    return { ended, itsReplyId };
  }

  it('does not mark a reply that finished as one that was cut off', async () => {
    const { ended, itsReplyId } = await aLateEnding();

    ended.onError?.(new StreamDroppedError(new Error('socket closed')));

    // The reply is on the record as finished. Marking it now would put
    // "stopped" on an answer the reader watched arrive in full.
    const its = conversation()?.messages.find((m) => m.id === itsReplyId);
    expect(its?.interrupted).toBeUndefined();
  });

  it('says nothing, because nobody is waiting on it', async () => {
    const { ended } = await aLateEnding();
    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));

    ended.onError?.(new StreamDroppedError(new Error('socket closed')));
    stop();

    // A line about a turn that is over reads as a line about the one on
    // screen now, which is running perfectly well.
    expect(told).toEqual([]);
  });

  it('leaves the turn that is running alone', async () => {
    const { ended } = await aLateEnding();
    const running = conversation()?.turn?.replyId;

    ended.onError?.(new StreamDroppedError(new Error('socket closed')));

    expect(conversation()?.turn?.replyId).toBe(running);
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

    handlers.onError?.(new StreamRefusedError(402, 'You are out of credits.', true));
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
  /**
   * Answer the next turn with a refusal, the way the transport really does.
   *
   * `sseStream` never rejects: it catches, hands the failure to `onError`
   * from the catch at the end of its own body, and returns. So a refusal and
   * the end of the call are one moment, and whoever is waiting on the call
   * hears about it.
   * @param refusal - What the turn ends with.
   */
  function refuseTheTurn(refusal: unknown): void {
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(refusal);
    });
  }

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
    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' })]);
  });

  it('passes on what the server said, when the server answered', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    // Refused and done with, which is the shape the transport really has:
    // `sseStream` hands the failure to `onError` from the catch at the end of
    // its own body and returns. Driving `onError` on a call that then hangs
    // would be modelling a transport we do not have -- and the send is what
    // decides whether a refusal is the last word, so it has to get there.
    refuseTheTurn(new StreamRefusedError(402, 'You are out of credits.', true));

    const told = await whatIsTold(async () => {
      await conversationRuntime.send('p-1', 'hello');
    });

    // Getting an answer at all means the network was fine, so this is not a
    // network error -- and the server wrote the only sentence anyone wrote
    // about it, in the reader's own language.
    expect(told).toEqual([
      expect.objectContaining({
        projectId: 'p-1',
        conversationId: 'c-1',
        kind: 'server',
        message: 'You are out of credits.',
      }),
    ]);
  });

  it('calls it a network error when the request never left', async () => {
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    refuseTheTurn(new StreamUnreachableError(new Error('offline')));

    const told = await whatIsTold(async () => {
      await conversationRuntime.send('p-1', 'hello');
    });

    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' })]);
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

    expect(told).toEqual([expect.objectContaining({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' })]);
    // Still offering, because the reader may simply press it again.
    expect(conversation()?.hasMore).toBe(true);
  });
});

describe('the wait between the press and the server answering', () => {
  it('has two ways out, and the one that fails leaves the words where they are', async () => {
    // The reader pressed send and nothing came back. What ends this is one of
    // two things: the server says it has the message, or the connection stops
    // saying it is alive. This is the second.
    vi.useFakeTimers();
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    conversationRuntime.setDraft('p-1', 'c-1', 'the one I sent');

    const told: ChatMishap[] = [];
    const stop = watchChatMishaps((m) => told.push(m));
    void conversationRuntime.send('p-1', 'the one I sent');
    await vi.waitFor(() => expect(conversation()?.turn).not.toBeNull());
    expect(turnPhaseOf(useConversationRuntime.getState(), 'p-1')).toBe('sending');

    vi.advanceTimersByTime(SSE_HEARTBEAT_TIMEOUT_MS + 1);
    stop();

    // Nothing of this turn ever reached the screen, so nothing has to be
    // taken off it. The words never went anywhere this end can vouch for, so
    // they are still in the box and the button is a send button again --
    // pressing it is the whole of what there is to do.
    expect(conversationRuntime.draftOf('p-1', 'c-1')).toBe('the one I sent');
    expect(turnPhaseOf(useConversationRuntime.getState(), 'p-1')).toBe('idle');
    expect(told).toHaveLength(1);
    // Sending it again can store the same question twice -- the first may have
    // arrived and been written down before the line went. That is not a thing
    // this end can find out, and two identical questions in a row is the
    // honest result of not knowing.
  });
});

describe('a send that outlives the visit that made it', () => {
  it('does not put the words on a replacement after the reader has gone', async () => {
    // The first attempt is refused, a replacement opens, and the reader walks
    // out of the project in between. Sending now runs a turn on a conversation
    // this visit is not looking at -- and `leaveProject` has already dropped
    // the entry, so nothing registers the turn and nothing can stop it: the
    // model runs on their account with the switch out of reach.
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });
    let handOver: (r: Awaited<ReturnType<typeof chatApi.openChat>>) => void = () => {};
    vi.mocked(chatApi.openChat).mockReturnValueOnce(
      new Promise((resolve) => {
        handOver = resolve;
      }),
    );

    const sending = conversationRuntime.send('p-1', 'hello');
    await vi.waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));
    conversationRuntime.leaveProject('p-1');
    handOver({
      conversations: [{ id: 'c-2' }],
      current: { conversation: { id: 'c-2' }, messages: [], hasMore: false },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
    await sending;

    expect(chatApi.streamMessage).toHaveBeenCalledTimes(1);
  });
});

describe('a conversation handed back under the id it already had', () => {
  it('keeps the count of what failed while the reader was here', async () => {
    // The count answers "did one fail while I was watching", and the panel
    // holds it against where it stood when this conversation came up. Rebuilt
    // from an answer describing the same conversation, it must not restart --
    // the server is not describing how many turns failed in front of a reader,
    // and a count that restarts under a baseline that does not is a failure
    // nobody is told about.
    openChatAnswers();
    await conversationRuntime.ensureLoaded('p-1');
    useConversationRuntime.setState((s) => ({
      conversations: {
        ...s.conversations,
        'c-1': { ...s.conversations['c-1']!, failures: 2, failedReplyId: 'r-2' },
      },
    }));

    // The same answer arrives again -- a re-open that hands back the same one.
    await conversationRuntime.ensureLoaded('p-1');
    useConversationRuntime.setState((s) => ({ openStatus: { ...s.openStatus, 'p-1': 'idle' } }));
    await conversationRuntime.ensureLoaded('p-1');

    expect(conversation()?.failures).toBe(2);
    expect(conversation()?.failedReplyId).toBe('r-2');
  });
});
