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
import { StreamRefusedError } from '@web/data/stream/sse';
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
      await result.current.send('hi');
    });

    // A conversation refused the moment it was made is not a stale id, and
    // asking again would only ask again.
    expect(chatApi.streamMessage).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.messages.at(-1)?.failed).toBe(true));
  });

  it('shows the failure for a refusal it cannot recover from', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));

    vi.mocked(chatApi.streamMessage).mockImplementationOnce(async (_input, h) => {
      h.onError?.(new StreamRefusedError(403, 'Forbidden'));
    });

    await act(async () => {
      await result.current.send('hi');
    });

    // Being refused for lack of permission is not fixed by trying again.
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.messages.at(-1)?.failed).toBe(true));
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

describe('when the turn is over', () => {
  it('replaces the local copy of the reply with what was actually stored', async () => {
    openChatAnswers([]);
    const { result } = render();
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      void result.current.send('search for something');
    });

    // The panel builds its own copy of the reply as the pieces arrive, and
    // that copy only ever carries prose. What the server stores is the whole
    // of it — the tool it reached for, the reasoning, its real id.
    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_CHUNK, data: { text: 'Found two.' } });
    });

    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1' }],
      current: {
        conversation: { id: 'c-1' },
        messages: [
          {
            id: 'stored-user',
            role: 'user',
            parts: [{ type: 'text', text: 'search for something' }],
            content: 'search for something',
            ts: '2026-08-11T00:00:00Z',
            turnIndex: 1,
          },
          {
            id: 'stored-reply',
            role: 'assistant',
            parts: [
              { type: 'text', text: 'Found two.' },
              {
                type: 'tool',
                toolCallId: 'tc-1',
                toolName: 'web_search',
                input: {},
                status: 'success',
                output: 'two links',
              },
            ],
            content: 'Found two.',
            ts: '2026-08-11T00:00:01Z',
            turnIndex: 1,
          },
        ],
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    act(() => {
      handlers.onEvent({ event: SSE_EVENT_NAMES.CHAT_DONE, data: {} });
    });

    // Without this the tool the agent used is missing from the reply until
    // the panel is opened again, and the message on screen keeps an id the
    // server has never heard of.
    await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe('stored-reply'));
    expect(result.current.messages.at(-1)?.toolCalls ?? []).toHaveLength(1);
  });
});

describe('when reopening the chat also fails', () => {
  it('still says the turn failed instead of leaving the screen bare', async () => {
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
      await result.current.send('find me references');
    });

    // What the user said stays, and something on screen says it did not get
    // an answer. Without this the turn ends with nothing at all: no reply, no
    // marker, and the panel still believes the chat is open.
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.content)).toContain('find me references'),
    );
    expect(result.current.messages.at(-1)?.failed).toBe(true);
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
