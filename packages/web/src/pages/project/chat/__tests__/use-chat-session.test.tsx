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
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useChatSession('p-1'), { wrapper: makeWrapper(client) });
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

    act(() => {
      result.current.abort();
    });

    // The server's ending never arrives on this path: the connection is gone
    // before it is written, so nothing but this clears the flag.
    expect(useChatStore.getState().streaming).toBe(false);
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
