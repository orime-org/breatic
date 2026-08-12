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

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

/** The stream handlers the hook installed on its last send. */
let handlers: {
  onEvent: (e: SSEEventEnvelope) => void;
  onClose?: () => void;
  onError?: (err: unknown) => void;
  signal?: AbortSignal;
};

/**
 * Wrap the hook in a query client of its own.
 * @param client - The client backing this render
 * @returns The wrapper component
 */
function makeWrapper(
  client: QueryClient,
): (props: { children: React.ReactNode }) => React.JSX.Element {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * Answer the open call with one conversation and the given messages.
 * @param messages - What has been said in it so far
 */
function openChatAnswers(messages: Array<{ id: string; role: string; text: string }>): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c-1' }],
    current: {
      conversation: { id: 'c-1' },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: 'text', text: m.text }],
        content: m.text,
        ts: '2026-08-11T00:00:00Z',
        turnIndex: 1,
      })),
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * Render the hook against a fresh client.
 * @returns The render result, for reading `current` off it
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> & {
  client: QueryClient;
  } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    ...renderHook(() => useChatSession('p-1'), { wrapper: makeWrapper(client) }),
    client,
  };
}

/**
 * The messages as the cache holds them, readable after the panel is gone.
 * @param client - The client backing the render under test
 * @returns Those messages, or an empty list when nothing is cached
 */
function cachedMessages(client: QueryClient): Array<{ streaming?: boolean }> {
  const data = client.getQueryData(['chat-open', 'p-1']) as
    | { current: { messages: Array<{ streaming?: boolean }> } }
    | undefined;
  return data?.current.messages ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
    handlers = h;
  });
});

describe('what the panel shows when it opens', () => {
  it('asks the server once and shows what it says', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'hello' },
      { id: 'm2', role: 'assistant', text: 'hi there' },
    ]);

    const { result } = render();

    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(chatApi.openChat).toHaveBeenCalledWith('p-1');
    expect(result.current.messages.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });

  it('shows nothing until the server has answered', () => {
    openChatAnswers([]);
    const { result } = render();

    // Not an empty conversation — an unanswered one. Rendering the empty
    // state here would flash "start a conversation" over a conversation that
    // is about to arrive.
    expect(result.current.isPending).toBe(true);
  });
});

describe('sending a message', () => {
  it('shows what the user said before the server has said anything', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    await act(async () => {
      void result.current.send('find me references');
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.content)).toContain('find me references'),
    );
  });

  it('grows the reply as the pieces arrive, in one place', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
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
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
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
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
    });

    expect(useChatStore.getState().streaming).toBe(true);

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    // The composer reads this to decide between send and stop. Leaving it on
    // strands the user with a stop button and no way to send anything.
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it('stops streaming when the turn fails', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
    });

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.ERROR, data: { message: 'whatever' } });
    });

    expect(useChatStore.getState().streaming).toBe(false);
    await waitFor(() => expect(result.current.messages.at(-1)?.failed).toBe(true));
  });

  it('stops streaming when the user stops the turn', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
    });

    // Wait for the reply to actually be on screen and marked, or the
    // assertions below pass against an empty list without testing anything.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBe(true));

    act(() => {
      result.current.abort();
    });

    // The server's ending never arrives on this path: the connection is gone
    // before it is written, so nothing but this clears the flag.
    expect(useChatStore.getState().streaming).toBe(false);
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
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found'));
    });

    await act(async () => {
      await result.current.send('find me references');
    });

    await waitFor(() => expect(chatApi.openChat).toHaveBeenCalledTimes(2));
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    expect(result.current.messages.map((m) => m.content)).toContain('find me references');
  });

  it('gives up rather than looping when the new one is refused too', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    vi.mocked(chatApi.streamMessage).mockImplementation(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found'));
    });

    await act(async () => {
      await expect(result.current.send('hi')).rejects.toThrow();
    });

    // A conversation refused the moment it was made is not a stale id, and
    // asking again would only ask again. The server kept no record of any of
    // it, so nothing about it is left on screen either — `send` saying it was
    // not sent is what the composer acts on.
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });

  it('shows the failure for a refusal it cannot recover from', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(403, 'Forbidden'));
    });

    await act(async () => {
      await expect(result.current.send('hi')).rejects.toThrow();
    });

    // Being refused for lack of permission is not fixed by trying again, and
    // the turn never ran, so there is nothing of it to show.
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });
});

describe('when the chat never opened', () => {
  it('says so rather than looking like an empty conversation', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    const { result } = render();

    // An empty chat invites the user to start one. A chat that failed to open
    // must not look like that, or every message they send disappears into it.
    await waitFor(() => expect(result.current.failedToOpen).toBe(true));
  });

  it('does not swallow what the user typed', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('server said no'));
    const { result } = render();
    await waitFor(() => expect(result.current.failedToOpen).toBe(true));

    // `send` resolving as if it worked is what let the composer clear the
    // draft: the user pressed enter, their words vanished, nothing was sent.
    await expect(result.current.send('please do not eat this')).rejects.toThrow();
  });
});

describe('when the connection dies mid-reply', () => {
  it('marks the reply the way the server records it: stopped, not failed', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
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
    await waitFor(() => expect(result.current.isPending).toBe(false));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamUnreachableError(new TypeError('Failed to fetch')));
    });

    // Nothing was sent, so the server stored nothing — not the reply, and not
    // even what the user typed, which it writes as the first thing inside the
    // turn. Saying "Stopped" here announces that a reply was cut off when no
    // reply was ever begun.
    await expect(result.current.send('is anyone there')).rejects.toThrow();

    const last = result.current.messages.at(-1);
    expect(last?.interrupted).toBeUndefined();
  });
});

describe('when a stale error arrives after the turn is over', () => {
  it('leaves the finished reply alone', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
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
    await waitFor(() => expect(result.current.isPending).toBe(false));

    // The conversation is gone, and the attempt to open a fresh one fails too
    // — the server is down, or the project went away with it.
    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(404, 'Resource not found'));
    });
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('server said no'));

    await act(async () => {
      await expect(result.current.send('find me references')).rejects.toThrow();
    });

    // Nothing was stored for this attempt — not the reply, and not what the
    // user typed, which the server writes inside the turn. Leaving either on
    // screen would show a conversation the server does not have. Saying it
    // was not sent is what lets the composer hand the words back.
    expect(result.current.messages.some((m) => m.failed)).toBe(false);
  });
});

describe('when the panel goes away mid-stream', () => {
  it('leaves nothing claiming a turn is still running', async () => {
    openChatAnswers([]);
    const { result, unmount, client } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
    });
    expect(useChatStore.getState().streaming).toBe(true);
    // The reply has to actually be on screen and marked, or what follows
    // passes against an empty list without testing anything.
    await waitFor(() => expect(result.current.messages.at(-1)?.streaming).toBe(true));

    // Collapsing the chat column unmounts the panel. The store outlives it,
    // so a flag left on strands the composer showing a stop button for a turn
    // that ended, and nothing can be sent until it is clicked.
    act(() => {
      unmount();
    });

    expect(useChatStore.getState().streaming).toBe(false);
    // The cache outlives the panel too. Left marked, the half-written reply
    // still has its typing cursor when the column is opened again.
    expect(cachedMessages(client).at(-1)?.streaming).toBeUndefined();
  });
});

describe('the model thinking out loud', () => {
  it('collects the thinking onto the reply it belongs to', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('hi');
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
