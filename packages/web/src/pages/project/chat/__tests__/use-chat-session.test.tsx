// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one place the chat panel reads its messages from.
 *
 * History and the reply being streamed are the same list. Keeping them apart
 * — the history in a cache, the streaming reply in a variable of its own — is
 * what makes a reply appear twice, or vanish at the moment the stream ends,
 * or come back in the wrong order after a refresh. So the stream writes into
 * the same cache the history came from, and the screen reads only that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import { SSE_EVENT_NAMES } from '@breatic/shared';
import type { SSEEventEnvelope } from '@breatic/shared';

vi.mock('@web/data/api/chat', () => ({
  chatApi: { openChat: vi.fn(), streamMessage: vi.fn() },
}));

import { chatApi } from '@web/data/api/chat';
import {
  StreamRefusedError,
  StreamUnreachableError,
  StreamDroppedError,
} from '@web/data/stream/sse';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { useChatStore } from '@web/stores';
import { useConversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';

/** The stream handlers the hook installed on its last send. */
let handlers: {
  onEvent: (e: SSEEventEnvelope) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
};

/**
 * Answer the open call with one conversation and the given messages.
 * @param messages - What has been said in it so far
 */
function openChatAnswers(
  messages: Array<{ id: string; role: string; text: string }>,
  conversationId = 'c-1',
): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: conversationId }],
    current: {
      conversation: { id: conversationId },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: 'text', text: m.text }],
        content: m.text,
        ts: '2026-08-11T00:00:00Z',
        turnIndex: 1,
      })),
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * Say the turn has begun, which is the server's first word on every turn.
 *
 * Until this arrives the browser has put nothing on screen: the reply has
 * nowhere to be written yet, and the question is only the server's to show.
 * @param texts - What the server says the conversation now holds, oldest first
 */
function turnStarts(texts: string[]): void {
  handlers.onEvent({
    event: SSE_EVENT_NAMES.CHAT_TURN_STARTED,
    data: {
      messages: texts.map((text, i) => ({
        id: `srv-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text }],
        content: text,
        ts: '2026-08-14T00:00:00Z',
        turnIndex: 10 + i,
      })),
      hasMore: false,
    },
  } as unknown as SSEEventEnvelope);
}

/**
 * Render the hook.
 * @returns The render result, for reading `current` off it
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  return renderHook(() => useChatSession('p-1'));
}

/**
 * The messages as the conversation holds them, readable after the panel is
 * gone -- which is the whole point of their living there.
 * @returns Those messages, or an empty list when nothing has been loaded
 */
function storedMessages(): Array<{ streaming?: boolean; failed?: boolean }> {
  const { conversations, currentByProject } = useConversationRuntime.getState();
  const id = currentByProject['p-1'];
  return id ? (conversations[id]?.messages ?? []) : [];
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  // A module singleton outlives every test in the file, which is the same
  // reason it outlives the panel.
  _resetForTests();
  vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
    handlers = h;
  });
});


/**
 * 打开这件事有结果了 —— 拿到会话,或者确定拿不到。
 * @param status - hook 报的打开进度。
 * @returns 有结果了没有。
 */
function settled(status: string): boolean {
  return status !== 'idle' && status !== 'loading';
}

describe('what the panel shows when it opens', () => {
  it('asks the server once and shows what it says', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'hello' },
      { id: 'm2', role: 'assistant', text: 'hi there' },
    ]);

    const { result } = render();

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(chatApi.openChat).toHaveBeenCalledWith('p-1', expect.any(AbortSignal));
    expect(result.current.messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });

  it('shows nothing until the server has answered', () => {
    openChatAnswers([]);
    const { result } = render();

    // Not an empty conversation — an unanswered one. Rendering the empty
    // state here would flash "start a conversation" over a conversation that
    // is about to arrive.
    expect(settled(result.current.status)).toBe(false);
  });
});

describe('sending a message', () => {
  it('is three states, and the middle one has no stop in it', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    expect(result.current.turnPhase).toBe('idle');

    await act(async () => {
      void result.current.send('hi');
    });

    // The request is out and the server has not answered. Nothing of this turn
    // is on screen, so there is nothing for stopping it to take back -- and
    // whether it is running at all is not something this end knows yet.
    expect(result.current.turnPhase).toBe('sending');

    act(() => {
      turnStarts(['hi']);
    });

    // Now the server has said it: the message is stored and the turn is its
    // to finish. From here stopping means something.
    expect(result.current.turnPhase).toBe('running');

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    expect(result.current.turnPhase).toBe('idle');
  });

  it('is waiting from the press, even before there is a conversation', async () => {
    // Nothing has been opened yet: this is the reader's first message in a
    // project whose chat could not be opened when they arrived.
    vi.mocked(chatApi.openChat).mockReturnValueOnce(new Promise(() => {}));
    const { result } = render();
    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalled());
    expect(result.current.turnPhase).toBe('idle');

    await act(async () => {
      void result.current.send('are you there');
    });

    // Sending opens a conversation first, which is a whole request. Read off
    // the turn alone this would still say `idle`, and the panel would keep a
    // live send button up for the length of it -- a second press there runs
    // the same sentence as a second turn.
    expect(result.current.turnPhase).toBe('sending');
  });

  it('shows what the user said as soon as the server says it has it', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    await act(async () => {
      void result.current.send('find me references');
    });

    // Not before. The browser can put its own copy of the question on screen
    // the moment the press lands, but it would be showing something it has no
    // word on -- and taking it down again on every refusal.
    expect(result.current.messages.map((m) => m.content)).not.toContain('find me references');

    act(() => {
      turnStarts(['find me references']);
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.content)).toContain('find me references'),
    );
  });

  it('grows the reply as the pieces arrive, in one place', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'A' } });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('A'));

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'B' } });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('AB'));

    // One reply, not one per piece.
    expect(result.current.messages).toHaveLength(2);
  });

  it('marks the reply in flight so the bubble can show it is being written', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    // Without this the bubble sits empty and still until the first token,
    // and the typing cursor in MessageBubble has nothing to render from.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBe(true));

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBeUndefined());
  });

  it('is streaming until the turn says it is done', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    expect(result.current.turnPhase).toBe('running');

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    // The composer reads this to decide between send and stop. Leaving it on
    // strands the user with a stop button and no way to send anything.
    expect(result.current.turnPhase).toBe('idle');
  });

  it('stops streaming when the turn fails', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'whatever' } });
    });

    expect(result.current.turnPhase).toBe('idle');
    await waitFor(() => expect(result.current.messages.at(-1)?.failed).toBe(true));
  });

  it('stops streaming when the user stops the turn', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    // Wait for the reply to actually be on screen and marked, or the
    // assertions below pass against an empty list without testing anything.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBe(true));

    act(() => {
      result.current.abort();
    });

    // The server's ending never arrives on this path: the connection is gone
    // before it is written, so nothing but this clears the flag.
    expect(result.current.turnPhase).toBe('idle');
    // And the reply itself has to stop claiming it is being written, or it
    // keeps its blinking cursor for as long as the panel stays open.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBeUndefined());

    // The half-written reply has to say it was cut off. The server records
    // exactly that, so without it the same message reads as a finished answer
    // now and as a stopped one after a reload.
    expect(result.current.messages.at(-1)?.interrupted).toBe(true);
  });
});

describe('when the conversation it was writing to is gone', () => {
  it('opens a new one and says the same thing again', async () => {
    // Another tab deleted this conversation. The user has already typed,
    // pressed enter, and watched their words appear — losing them here would
    // be losing something they did nothing wrong to lose.
    //
    // The conversation has something in it, which matters: this used to be
    // written with an empty one, and the code being tested picked the words
    // to re-send by hunting for the last user message in the list. An empty
    // list has no wrong message to find, so it could not have gone wrong here
    // however it was written.
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'an older question' },
      { id: 'm2', role: 'assistant', text: 'an older answer' },
    ]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });
    // A 404 says the conversation asked about is gone or not this project's,
    // so opening again cannot hand back the same one: `openChat` returns the
    // project's own most recent, or makes a new one.
    openChatAnswers(
      [
        { id: 'm1', role: 'user', text: 'an older question' },
        { id: 'm2', role: 'assistant', text: 'an older answer' },
      ],
      'c-2',
    );

    await act(async () => {
      await result.current.send('find me references');
    });

    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    // The second attempt is the one that got through, so it is the one that
    // hands the conversation back.
    act(() => {
      turnStarts(['an older question', 'an older answer', 'find me references']);
    });
    // What the second attempt sent is what the user typed, not whatever the
    // list happened to have in it.
    expect(vi.mocked(chatApi.streamMessage).mock.calls[1]?.[0].message).toBe(
      'find me references',
    );
    expect(result.current.messages.map((m) => m.content)).toContain('find me references');
  });

  it('gives up rather than looping when the new one is refused too', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });
    openChatAnswers([], 'c-2');

    await act(async () => {
      await result.current.send('hi');
    });

    // A conversation refused the moment it was made is not a stale id, and
    // asking again would only ask again. The server kept no record of any of
    // it, so nothing about it is left on screen either -- and nothing is
    // thrown at the caller, because there is nothing for it to do: the words
    // are still in the box and the reader can press send again.
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });

  it('shows the failure for a refusal it cannot recover from', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(403, 'Forbidden', true));
    });

    await act(async () => {
      await result.current.send('hi');
    });

    // Being refused for lack of permission is not fixed by trying again, and
    // the turn never ran, so there is nothing of it to show.
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });

  it('marks a failure the reader is living through, apart from one they are reading about', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'upstream said no' } });
    });

    // Both marks, and each in the place that matches how long it is true for.
    // `failed` is stored, so it belongs in the cache and comes back with the
    // history. The second says the failure is happening right now, in front
    // of someone waiting on it — true of this render and nothing else, so it
    // is not in the cache at all.
    await waitFor(() => {
      expect(result.current.messages.at(-1)?.failed).toBe(true);
      expect(result.current.messages.at(-1)?.failedJustNow).toBe(true);
    });
    expect(storedMessages().at(-1)?.failed).toBe(true);
    expect(storedMessages().at(-1)).not.toHaveProperty('failedJustNow');
  });

  it('forgets that it just happened once the panel goes away', async () => {
    openChatAnswers([]);
    // The conversation outlives the panel, which is the point: what survives
    // here is what the conversation holds, and nothing else.
    const first = render();
    await waitFor(() => expect(settled(first.result.current.status)).toBe(true));
    await act(async () => {
      void first.result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'upstream said no' } });
    });
    await waitFor(() => expect(first.result.current.messages.at(-1)?.failedJustNow).toBe(true));

    // Collapsing the agent column unmounts the panel; opening it again mounts
    // a new one over the same conversation.
    first.unmount();
    const second = render();
    await waitFor(() => expect(second.result.current.messages).toHaveLength(2));

    // The failure is still there to read — it is part of the conversation.
    // But nobody is living through it any more, and a bubble that still said
    // so would read the whole thing out again to a screen reader as if it had
    // just happened, minutes after the reader had already been told.
    expect(second.result.current.messages.at(-1)?.failed).toBe(true);
    expect(second.result.current.messages.at(-1)?.failedJustNow).toBeUndefined();
    second.unmount();
  });

  it('takes back what the user said when the server refused to hear it', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      // Being refused mid-flight: the request reached the server and came
      // back as an ordinary response, so the stream never opened and the
      // turn never ran.
      h.onError?.(new StreamRefusedError(403, 'Forbidden', true));
    });

    await act(async () => {
      await result.current.send('let me in');
    });

    // The server stored nothing — not the reply, and not the message the
    // user typed, which is only written once the turn is under way. Leaving
    // their bubble behind puts a message on screen that the conversation
    // does not contain, and it disappears on the next reload. Worse, the
    // composer takes the same words back as a draft, so the one sentence is
    // on screen twice: sent and unsent at once.
    expect(storedMessages()).toHaveLength(0);
  });
});

describe('while a reply is being written', () => {
  it('hands back the same object for every message that did not change', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'an earlier question' },
      { id: 'm2', role: 'assistant', text: 'an earlier answer' },
    ]);
    const { result } = render();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    await act(async () => {
      void result.current.send('and now this');
    });
    act(() => {
      turnStarts(['an earlier question', 'an earlier answer', 'and now this']);
    });
    const settled = result.current.messages.slice(0, 2);

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'One' } });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('One'));

    // This runs once per token. A conversation is only ever appended to, so
    // the settled messages behind the one being written have nothing new to
    // say; handing the panel new objects for them anyway redraws the whole
    // column on every token, and the longer the conversation the worse it
    // gets. `toBe`, not `toEqual` — equal content is exactly what fails to
    // stop a re-render.
    expect(result.current.messages[0]).toBe(settled[0]);
    expect(result.current.messages[1]).toBe(settled[1]);
  });
});

describe('when the network comes back mid-reply', () => {
  it('does not let a background refetch swallow the turn being written', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'Half a' } });
    });

    // Losing the network and getting it back is the ordinary case here — a
    // laptop lid, a train, switching to a hotspot. The server has no record
    // of this turn yet, so a list fetched from it does not contain either of
    // these two messages; writing it over the cache mid-reply takes the
    // turn off the screen while it is still being written, and every
    // remaining piece of the reply then lands on a message that is gone.
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await new Promise((r) => setTimeout(r, 0));
    });

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: ' sentence' } });
    });

    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Half a sentence'));
    expect(result.current.messages).toHaveLength(2);
    // The chat was opened once, when the panel mounted, and not again — the
    // reconnect did not start a fetch at all.
    expect(vi.mocked(chatApi.openChat)).toHaveBeenCalledTimes(1);
    expect(storedMessages()).toHaveLength(2);
  });
});

describe('when the panel is opened again over a conversation already loaded', () => {
  it('asks the server nothing, because there is nothing it could learn', async () => {
    openChatAnswers([{ id: 'm1', role: 'user', text: 'earlier' }]);
    const first = render();
    await waitFor(() => expect(first.result.current.messages).toHaveLength(1));

    // A turn is running when the column is collapsed, which is the case that
    // used to go wrong: a refetch started on the way back in would answer
    // with a snapshot taken before this turn existed, and writing it would
    // take the reply off the screen while it was still arriving.
    await act(async () => {
      void first.result.current.send('hello');
    });
    act(() => {
      turnStarts(['earlier', 'hello']);
    });
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'A' } });
    });
    await waitFor(() => expect(first.result.current.messages).toHaveLength(3));

    act(() => {
      first.unmount();
    });
    const second = render();
    await waitFor(() => expect(second.result.current.messages).toHaveLength(3));

    // Opened once, when the first panel mounted. Not on the way back in, and
    // not on a reconnect either -- there is no automatic refetch behind this
    // any more, so the whole class of "a stale answer overwrote the turn" is
    // not something a guard has to catch.
    expect(vi.mocked(chatApi.openChat)).toHaveBeenCalledTimes(1);
    expect(second.result.current.messages.at(-1)?.content).toBe('A');
    expect(second.result.current.messages.at(-1)?.streaming).toBe(true);
  });
});

describe('when one turn ends after the next has started', () => {
  it('does not let the late ending clear the turn that is running now', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    await act(async () => {
      void result.current.send('first');
    });
    const firstTurn = handlers;
    act(() => {
      turnStarts(['first']);
    });

    // The first turn fails. The server is not finished with it — it still has
    // to write the turn down and charge for it before it sends `chat_done` —
    // but the composer is already live again, so the reader can send.
    act(() => {
      firstTurn.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'upstream said no' } });
    });
    await waitFor(() => expect(result.current.turnPhase).toBe('idle'));

    await act(async () => {
      void result.current.send('second');
    });
    // The second turn's own messages come with its first event, and that is
    // what puts them on screen: four in all, the first pair and this one.
    act(() => {
      turnStarts(['first', 'the first reply', 'second']);
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(4));
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'writing' } });
    });
    expect(result.current.turnPhase).toBe('running');

    // Now the first turn's `chat_done` arrives.
    act(() => {
      firstTurn.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    // It belongs to a turn that is over. Letting it end the current one puts
    // a send button over a reply still being written, and the request behind
    // it can no longer be stopped by anything — not the button, not closing
    // the panel.
    expect(result.current.turnPhase).toBe('running');
    expect(result.current.messages.at(-1)?.streaming).toBe(true);
  });
});

describe('when asking the server again fails', () => {
  it('keeps the conversation on screen rather than claiming the chat never opened', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'an earlier question' },
      { id: 'm2', role: 'assistant', text: 'an earlier answer' },
    ]);
    const { result } = render();
    await waitFor(() => expect(result.current.messages).toHaveLength(2));

    // The conversation is already on screen. Now a background refetch fails —
    // a cookie that expired while the tab sat idle, a 5xx blip.
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await new Promise((r) => setTimeout(r, 50));
    });

    // Nothing about the conversation changed: it is the same conversation,
    // still readable. Saying "the chat failed to open" and taking every
    // bubble off the screen tells the reader their history is gone, when it
    // is sitting in the cache untouched.
    expect(result.current.messages).toHaveLength(2);
  });
});

describe('when the chat never opened', () => {
  it('looks like an empty conversation, because that is what is on screen', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    const { result } = render();

    // Nothing came back, so there is nothing to show, and that is the whole of
    // it. The line about what went wrong was said once at the moment it
    // happened; an empty list needs no second explanation, and a state saying
    // "this could not be opened" would be one -- standing there for as long as
    // the reader looks at it, about something they can neither fix nor retry.
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    expect(result.current.messages).toEqual([]);
  });

  it('starts a conversation when the reader sends anyway', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('server said no'));
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    // Pressing send is the whole of what they have to do. Opening happens on
    // the way, and this is why nothing on the screen needs turning off: there
    // is no dead end to keep them out of.
    openChatAnswers([]);
    await act(async () => {
      void result.current.send('please do not eat this');
    });

    await waitFor(() => expect(chatApi.streamMessage).toHaveBeenCalled());
    expect(vi.mocked(chatApi.streamMessage).mock.calls[0]?.[0].message).toBe(
      'please do not eat this',
    );
  });
});

describe('when the connection dies mid-reply', () => {
  it('marks the reply the way the server records it: stopped, not failed', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'Half a sen' } });
    });

    // The socket dies on its own — not the user pressing stop, and not the
    // server saying it failed. The server cannot tell those two apart: both
    // reach it as the client going away, and it records the turn as stopped.
    act(() => {
      handlers.onError?.(new StreamDroppedError(new TypeError('network error')));
    });

    // So the panel has to say the same thing. Calling it a failure here is
    // the panel inventing a verdict the record will contradict on reload.
    await waitFor(() => expect(result.current.messages.at(-1)?.interrupted).toBe(true));
    expect(result.current.messages.at(-1)?.failed).toBeUndefined();
  });
});

describe('when the request never reached the server', () => {
  it('does not call it a stopped reply, and hands the words back', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamUnreachableError(new TypeError('Failed to fetch')));
    });

    // Nothing was sent, so the server stored nothing — not the reply, and not
    // even what the user typed, which it writes as the first thing inside the
    // turn. Saying "Stopped" here announces that a reply was cut off when no
    // reply was ever begun.
    await result.current.send('is anyone there');

    const last = result.current.messages.at(-1);
    expect(last?.interrupted).toBeUndefined();
  });
});

describe('when a stale error arrives after the turn is over', () => {
  it('leaves the finished reply alone', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'All done.' } });
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBeUndefined());

    // The turn ended. A late error belongs to nothing that is still running,
    // and stamping it on the finished reply says it was cut off when it was
    // not.
    act(() => {
      handlers.onError?.(new StreamDroppedError(new TypeError('late')));
    });

    expect(result.current.messages.at(-1)?.interrupted).toBeUndefined();
  });
});

describe('when reopening the chat also fails', () => {
  it('says it was not sent rather than leaving a reply the server never kept', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));

    // The conversation is gone, and the attempt to open a fresh one fails too
    // — the server is down, or the project went away with it.
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found', true));
    });
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('server said no'));

    await act(async () => {
      await result.current.send('find me references');
    });

    // Nothing was stored for this attempt — not the reply, and not what the
    // user typed, which the server writes inside the turn. Leaving either on
    // screen would show a conversation the server does not have. Saying it
    // was not sent is what lets the composer hand the words back.
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });
});

describe('when the panel goes away mid-stream', () => {
  it('leaves the turn running, because collapsing the column is not leaving', async () => {
    openChatAnswers([]);
    const { result, unmount } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    // The reply has to actually be on screen and marked, or what follows
    // passes against an empty list without testing anything.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBe(true));

    // Collapsing the agent column unmounts the panel. The user is still in
    // the project and still paying for this turn; he put the panel away, he
    // did not say stop. Tearing the request down here is what makes the
    // answer he comes back for not exist.
    act(() => {
      unmount();
    });

    expect(handlers.signal?.aborted).toBe(false);
  });

  it('shows the same reply, still being written, when the column is opened again', async () => {
    openChatAnswers([]);
    const first = render();
    await waitFor(() => expect(settled(first.result.current.status)).toBe(true));
    await act(async () => {
      void first.result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });
    await waitFor(() => expect(first.result.current.messages.at(-1)?.streaming).toBe(true));

    act(() => {
      first.unmount();
    });

    // The model went on talking while the column was shut. Nobody was
    // rendering, and that is the point: the turn belongs to the conversation.
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'half an ans' } });
    });

    const second = render();
    await waitFor(() => expect(second.result.current.messages.at(-1)?.content).toBe('half an ans'));
    expect(second.result.current.messages.at(-1)?.streaming).toBe(true);
  });
});

describe('the model thinking out loud', () => {
  it('collects the thinking onto the reply it belongs to', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(settled(result.current.status)).toBe(true));
    await act(async () => {
      void result.current.send('hi');
    });
    act(() => {
      turnStarts(['hi']);
    });

    act(() => {
      handlers.onEvent({
        event: SSE_EVENT_NAMES.AGENT_THINKING,
        data: { text: 'let me ', blockId: 'r1' },
      });
      handlers.onEvent({
        event: SSE_EVENT_NAMES.AGENT_THINKING,
        data: { text: 'think', blockId: 'r1' },
      });
    });

    await waitFor(() => expect(result.current.messages.at(-1)?.thinking).toBe('let me think'));
  });
});

describe('a failure the reader is living through', () => {
  it('is announced even when the conversation changed under the panel', async () => {
    // "Did one fail while I was watching" is answered by comparing a counter
    // against where it stood when the panel arrived. The counter belongs to
    // the conversation, and the conversation can be replaced without the
    // panel going anywhere -- a press into one another tab deleted opens a
    // replacement, whose count starts at zero. Held against a number carried
    // over from the one before, the first failure in the new conversation
    // reads as old news and is not announced at all.
    _resetForTests();
    useConversationRuntime.setState({
      conversations: {
        'c-1': {
          projectId: 'p-1',
          messages: [
            { id: 'r-old', role: 'assistant', parts: [], content: 'x', ts: 'now', failed: true },
          ],
          turn: null,
          hasMore: false,
          oldestLoadedTurn: 1,
          failures: 1,
          failedReplyId: 'r-old',
        },
      },
      currentByProject: { 'p-1': 'c-1' },
      openStatus: { 'p-1': 'ready' },
    });

    const { result } = render();
    // The one it arrived with is history, and history is not announced.
    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe('r-old'));
    expect(result.current.messages.at(-1)?.failedJustNow).toBeUndefined();

    // The conversation is replaced under the panel. A fresh one has failed
    // nothing yet, which is what `adoptConversation` writes.
    act(() => {
      useConversationRuntime.setState((s) => ({
        conversations: {
          ...s.conversations,
          'c-2': {
            projectId: 'p-1',
            messages: [
              { id: 'r-new', role: 'assistant', parts: [], content: '', ts: 'now' },
            ],
            turn: null,
            hasMore: false,
            oldestLoadedTurn: 1,
            failures: 0,
            failedReplyId: null,
          },
        },
        currentByProject: { 'p-1': 'c-2' },
      }));
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe('r-new'));

    // And then a turn fails in it, with the reader watching.
    act(() => {
      useConversationRuntime.setState((s) => ({
        conversations: {
          ...s.conversations,
          'c-2': {
            ...s.conversations['c-2']!,
            messages: [
              { id: 'r-new', role: 'assistant', parts: [], content: '', ts: 'now', failed: true },
            ],
            failures: 1,
            failedReplyId: 'r-new',
          },
        },
      }));
    });

    await waitFor(() => expect(result.current.messages.at(-1)?.failed).toBe(true));
    expect(result.current.messages.at(-1)?.failedJustNow).toBe(true);
  });
});
