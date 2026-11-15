// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message from the press to the list, and what the screen shows meanwhile.
 *
 * A turn is not the answer to a send (inner#1717): the send is answered with
 * JSON once the server holds the message, which is when the box empties; the
 * message shows in the waiting area while it waits, and in the list once the
 * history read back before attaching to the run holds it. Everything above
 * axios and `fetch` is real -- the transport parsing the run's stream, the
 * `Chat` state machine, the hook subscribing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';

const toastSpy = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { error: toastSpy.error, warning: toastSpy.warning, success: vi.fn(), info: vi.fn() } }));
import { renderHook, waitFor, act } from '@testing-library/react';
import type * as ChatApiModule from '@web/data/api/chat';

vi.mock('@web/data/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatApiModule>();
  return {
    ...actual,
    chatApi: {
      streamConfig: vi.fn(async () => ({
        heartbeatIntervalMs: 5000,
        attachmentMaxChars: 200_000,
        attachmentMaxItems: 10,
        currentSpaceMaxChars: 100_000,
        spaceListMaxItems: 200,
        spaceReadTimeoutMs: 20_000,
        runningPollIntervalMs: 5000,
        syncIntervalMs: 3000,
      })),
      openChat: vi.fn(),
      readConversation: vi.fn(),
      listConversations: vi.fn(),
      createConversation: vi.fn(),
      messagesBefore: vi.fn(),
      running: vi.fn(async () => []),
      sync: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(),
      removeQueued: vi.fn(),
      streamPath: actual.chatApi.streamPath,
    },
  };
});

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { conversationRuntime, _resetForTests } from '@web/stores/conversation-runtime';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetChatLiveForTests } from '@web/stores/chat-live';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { replyOpens, stubRunWire } from '@web/test-utils/chat-run-wire';
import type { RunWire } from '@web/test-utils/chat-run-wire';

/** A sync answered while nothing holds the conversation; asked again soon, so a case need not wait. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 20 };

/** The run streams the page reads. */
let wire: RunWire;

/** What the server holds for c-1, as reading it back answers. */
let stored: StoredUiMessage[] = [];

/**
 * The user's message as the server stores it.
 * @param text - What it says.
 * @returns The row.
 */
function userRow(text: string): StoredUiMessage {
  return { id: 'u-1', role: 'user', parts: [{ type: 'text', text }], metadata: { turnIndex: 1, ts: '2026-08-11T00:00:00Z' } } as StoredUiMessage;
}

/**
 * What the server says this conversation holds when the chat is opened.
 * @param messages - What was said in it, in the protocol's shape.
 */
function openChatAnswers(messages: Array<Record<string, unknown>>): void {
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: 'c-1' }],
    current: {
      conversation: { id: 'c-1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
      messages,
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * Render what the panel reads.
 * @returns What renderHook returns.
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  return renderHook(() => useChatSession('p-1', () => ({ spaces: [] })));
}

/**
 * Render the panel and wait until it is open.
 * @returns What renderHook returns.
 */
async function anOpenPanel(): Promise<ReturnType<typeof render>> {
  const panel = render();
  await waitFor(() => {
    expect(panel.result.current.status).toBe('ready');
  });
  return panel;
}

/**
 * Hold the next send's answer until the case gives it.
 * @returns Gives the answer.
 */
function holdTheAnswer(): (answer: ChatSendAnswer) => void {
  let give: (answer: ChatSendAnswer) => void = () => undefined;
  vi.mocked(chatApi.sendMessage).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        give = resolve;
      }),
  );
  return (answer) => {
    give(answer);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = [];
  _resetForTests();
  evictAllChatSessions();
  openChatAnswers([]);
  wire = stubRunWire();
  vi.mocked(chatApi.readConversation).mockImplementation(async () => ({
    conversation: { id: 'c-1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
    messages: stored,
    hasMore: false,
  }) as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
  vi.mocked(chatApi.sync).mockResolvedValue(IDLE);
  vi.mocked(chatApi.sendMessage).mockResolvedValue({ status: 'start', pending: [], running: true });
});

afterEach(() => {
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.unstubAllGlobals();
});

describe('sending a message', () => {
  it('posts exactly the fields the server reads', async () => {
    const panel = await anOpenPanel();

    act(() => {
      void panel.result.current.send('find a few reference images');
    });
    await waitFor(() => {
      expect(chatApi.sendMessage).toHaveBeenCalled();
    });

    // Compared whole, not by inclusion: a field too many the server drops
    // without a word, one too few is a 422, and either way the user sees "it
    // did not send, and I do not know why".
    expect(vi.mocked(chatApi.sendMessage).mock.calls[0]?.[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: 'find a few reference images',
      project_id: 'p-1',
      conversation_id: 'c-1',
      attached_chips: [],
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      model: 'deepseek/deepseek-v4.1-flash-1017',
      spaces: [],
      spaces_total: 0,
    });
  });

  it('adds no bubble before the server has answered', async () => {
    const panel = await anOpenPanel();
    holdTheAnswer();

    act(() => {
      void panel.result.current.send('find a few reference images');
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('sending');
    });
    expect(panel.result.current.messages).toHaveLength(0);
  });

  it('shows the words from the history read back, and the reply from the run (RW-11)', async () => {
    const panel = await anOpenPanel();
    stored = [userRow('find a few reference images')];

    act(() => {
      void panel.result.current.send('find a few reference images');
    });
    await waitFor(() => {
      expect(wire.last()).not.toBeNull();
    });

    act(() => {
      for (const chunk of replyOpens()) wire.last()?.push(chunk);
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('running');
    });
    // Messages go through useChat's own throttle, a different update from
    // turnPhase's, so wait for them.
    await waitFor(() => {
      expect(panel.result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(panel.result.current.messages[0]?.content).toBe('find a few reference images');
      expect(panel.result.current.messages[1]?.content).toBe('Sure');
    });
  });

  it('waits in the waiting area, and moves to the list once the history holds it (RW-11)', async () => {
    const panel = await anOpenPanel();
    const item = { id: 'u-1', sentAt: '2026-11-12T08:00:00.000Z', words: 'and make it blue', chips: [] };
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce({ status: 'queued', pending: [item], running: false });
    // Every sync says the same while it waits: the waiting area is the server's.
    vi.mocked(chatApi.sync).mockResolvedValue({ ...IDLE, pending: [item] });

    act(() => {
      void panel.result.current.send('and make it blue');
    });

    await waitFor(() => {
      expect(panel.result.current.waiting.pending).toEqual([item]);
    });
    expect(panel.result.current.messages).toHaveLength(0);

    // A run took it in: the server stores it, and the next sync says a run holds the conversation.
    stored = [userRow('and make it blue')];
    vi.mocked(chatApi.sync).mockResolvedValue({ ...IDLE, running: true });

    await waitFor(() => {
      expect(panel.result.current.waiting.pending).toEqual([]);
    });
    await waitFor(() => {
      expect(panel.result.current.messages.map((m) => m.content)).toEqual(['and make it blue']);
    });
  });
});

describe('the words in the box', () => {
  it('are emptied once the server holds the message, not at the press (RW-11)', async () => {
    const panel = await anOpenPanel();
    act(() => {
      conversationRuntime.setDraft('c-1', 'find a few reference images');
    });
    const answer = holdTheAnswer();

    act(() => {
      void panel.result.current.send('find a few reference images');
    });
    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('sending');
    });
    // The server has not answered. Emptied now, a refused message would take
    // the user's words with it, and nothing could put them back.
    expect(panel.result.current.draft).toBe('find a few reference images');

    act(() => {
      answer({ status: 'start', pending: [], running: true });
    });

    await waitFor(() => {
      expect(panel.result.current.draft).toBe('');
    });
  });

  it('are emptied in this conversation only, another one left alone', async () => {
    const panel = await anOpenPanel();
    act(() => {
      conversationRuntime.setDraft('c-1', 'find a few reference images');
      conversationRuntime.setDraft('c-2', 'half a sentence never sent in the other one');
    });

    act(() => {
      void panel.result.current.send('find a few reference images');
    });
    await waitFor(() => {
      expect(panel.result.current.draft).toBe('');
    });

    expect(conversationRuntime.draftOf('c-2')).toBe('half a sentence never sent in the other one');
  });
});

describe('when it cannot be sent', () => {
  it('tells the user, without quietly opening a new conversation to put the words in', async () => {
    // The conversation is gone on the server -- another tab or another person
    // deleted it -- and the server answers 404. Nothing reopens: that would
    // put the words in a conversation that appeared from nowhere while the old
    // one's history is still on screen (user 2026-08-19).
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 404, message: 'Conversation not found', fromServer: true }),
    );
    const panel = await anOpenPanel();

    await act(async () => {
      await panel.result.current.send('find a few reference images');
    });

    await waitFor(() => {
      expect(toastSpy.error).toHaveBeenCalled();
    });
    // One request, not two: a second one is that "open another and send again".
    expect(chatApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(chatApi.createConversation).not.toHaveBeenCalled();
  });
});
