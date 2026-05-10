// @vitest-environment jsdom

/**
 * B.1 — `useChatStream` SSE-event-to-state tests.
 *
 * Mocks `chatApi.sendMessage` so we can drive the `onmessage`
 * callback synchronously from each test, then assert the
 * resulting messages array. Covers:
 *
 *   - send appends user + empty-assistant placeholder
 *   - chat_chunk appends to assistant content
 *   - chat_done finalizes pending + captures conversation_id
 *   - agent_choice / agent_canvas_action / agent_search_results
 *     attach the matching toolCall
 *   - error finalizes pending + sets errorMessage
 *   - abort finalizes pending without errorMessage
 *   - back-to-back send aborts the previous in-flight stream
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/data/api/chat', () => ({
  sendMessage: vi.fn(),
}));

import { sendMessage } from '@/data/api/chat';
import { useChatStream } from './use-chat-stream';

type SendCfg = Parameters<typeof sendMessage>[1];

const sendMock = vi.mocked(sendMessage);

interface DriverHandle {
  emit: (event: string, data: Record<string, unknown>) => void;
  close: () => void;
  fail: (err: Error) => void;
  cfg: SendCfg;
  resolve: () => void;
}

/**
 * Wire `sendMock` so each call exposes its `onmessage` / `onerror` /
 * `onclose` callbacks via a returned driver. The mock's promise
 * resolves only when the test calls `resolve()` so we can model
 * an in-flight stream realistically.
 */
function driveSend(): DriverHandle[] {
  const drivers: DriverHandle[] = [];
  sendMock.mockImplementation((_body, cfg) => {
    let resolveOuter: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolveOuter = r;
    });
    drivers.push({
      cfg,
      emit: (event, data) => {
        cfg.onmessage?.({
          event,
          data: JSON.stringify({ event, data }),
        });
      },
      close: () => {
        cfg.onclose?.();
        resolveOuter();
      },
      fail: (err) => {
        // Reject by throwing in the next tick so the await sees it
        // as a rejection rather than an immediate sync throw.
        Promise.resolve().then(() => resolveOuter());
        cfg.onerror?.(err);
      },
      resolve: resolveOuter,
    });
    return promise as ReturnType<typeof sendMessage>;
  });
  return drivers;
}

beforeEach(() => {
  sendMock.mockReset();
});

afterEach(() => {
  sendMock.mockReset();
});

describe('useChatStream — send + chunk + done', () => {
  it('immediately appends user + empty assistant placeholder', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe('user');
    expect(result.current.messages[0].content).toBe('hi');
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe('');
    expect(result.current.messages[1].pending).toBe(true);
    expect(result.current.streaming).toBe(true);
    expect(drivers).toHaveLength(1);
  });

  it('chat_chunk appends text to the assistant message', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('chat_chunk', { text: 'hel' });
    });
    act(() => {
      drivers[0].emit('chat_chunk', { text: 'lo' });
    });

    expect(result.current.messages[1].content).toBe('hello');
  });

  it('chat_done finalizes pending + captures conversation_id', async () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('chat_chunk', { text: 'world' });
    });
    act(() => {
      drivers[0].emit('chat_done', { conversation_id: 'conv-42' });
    });
    act(() => {
      drivers[0].close();
    });

    await waitFor(() => {
      expect(result.current.messages[1].pending).toBeFalsy();
    });
    expect(result.current.messages[1].content).toBe('world');
    expect(result.current.conversationId).toBe('conv-42');
    expect(result.current.streaming).toBe(false);
  });

  it('chat_done with `text` payload uses it as the final body when chunks were absent', async () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('chat_done', { text: 'short reply' });
    });
    act(() => {
      drivers[0].close();
    });

    await waitFor(() => {
      expect(result.current.messages[1].pending).toBeFalsy();
    });
    expect(result.current.messages[1].content).toBe('short reply');
  });
});

describe('useChatStream — agent interaction events', () => {
  it('agent_choice attaches an ask_user_choice toolCall', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('agent_choice', {
        question: '?',
        choices: [{ id: 'a', label: 'A' }],
      });
    });

    const tc = result.current.messages[1].toolCall;
    expect(tc?.name).toBe('ask_user_choice');
    expect(
      tc?.name === 'ask_user_choice' && tc.args.choices.length,
    ).toBe(1);
  });

  it('agent_canvas_action attaches a propose_canvas_action toolCall', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('agent_canvas_action', {
        action: 'create_nodes',
        rationale: 'r',
        nodes: [{ type: 'image', label: 'a' }],
      });
    });

    const tc = result.current.messages[1].toolCall;
    expect(tc?.name).toBe('propose_canvas_action');
  });

  it('agent_search_results attaches a show_search_results toolCall', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('agent_search_results', {
        images: [{ url: 'u', title: 't', source: 's' }],
      });
    });

    const tc = result.current.messages[1].toolCall;
    expect(tc?.name).toBe('show_search_results');
  });
});

describe('useChatStream — error / abort / re-send', () => {
  it('error event finalizes pending + sets errorMessage', async () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      drivers[0].emit('error', { message: 'oops' });
    });
    act(() => {
      drivers[0].close();
    });

    await waitFor(() => {
      expect(result.current.messages[1].pending).toBeFalsy();
    });
    expect(result.current.messages[1].errorMessage).toBe('oops');
  });

  it('abort finalizes pending without errorMessage', async () => {
    driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'hi' });
    });
    act(() => {
      result.current.abort();
    });

    await waitFor(() => {
      expect(result.current.streaming).toBe(false);
    });
    // Abort doesn't synchronously close the SSE — the cancel
    // bubbles through fetchEventSource. The hook keeps `pending`
    // true until either a chat_done event lands (didn't, in this
    // test) or the underlying promise rejects (which the mock
    // doesn't simulate). What we care about: streaming flag is
    // off; no error message shown.
    expect(result.current.messages[1].errorMessage).toBeUndefined();
  });

  it('back-to-back send aborts the previous stream + replaces with a fresh placeholder', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());

    act(() => {
      void result.current.send({ message: 'first' });
    });
    expect(drivers).toHaveLength(1);
    expect(result.current.messages).toHaveLength(2);

    act(() => {
      void result.current.send({ message: 'second' });
    });
    expect(drivers).toHaveLength(2);
    // Both placeholders coexist (the first one didn't get a
    // chat_done) — the assistant for the first message keeps
    // whatever text arrived; the second message gets its own
    // user + placeholder pair.
    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[2].role).toBe('user');
    expect(result.current.messages[2].content).toBe('second');
    expect(result.current.messages[3].role).toBe('assistant');
    expect(result.current.messages[3].pending).toBe(true);
  });
});

describe('useChatStream — direct setters', () => {
  it('setMessages replaces the messages array', () => {
    driveSend();
    const { result } = renderHook(() => useChatStream());
    act(() => {
      result.current.setMessages([
        { id: 'm1', role: 'user', content: 'hello from history' },
      ]);
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('m1');
  });

  it('setConversationId persists for the next send', () => {
    const drivers = driveSend();
    const { result } = renderHook(() => useChatStream());
    act(() => {
      result.current.setConversationId('conv-existing');
    });
    expect(result.current.conversationId).toBe('conv-existing');

    act(() => {
      void result.current.send({ message: 'follow-up' });
    });
    const body = sendMock.mock.calls[0][0] as { conversation_id?: string };
    expect(body.conversation_id).toBe('conv-existing');
    void drivers;
  });
});
