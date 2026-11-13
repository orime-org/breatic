// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one place the panel reads what it draws from.
 *
 * History and the reply being written are one list -- keeping them apart (the
 * history in one place, the streamed reply in another variable) is where "a
 * reply shows twice", "the reply vanishes when the stream ends" and "the order
 * is wrong after a refresh" came from. The list is held by a `Chat` instance,
 * and this hook turns it into what the panel can draw: the text and the
 * thinking each joined across parts, the tool calls as one list, the
 * interrupted and failed marks read out.
 *
 * A run is the server's (inner#1717): a send is answered with JSON, the page
 * reads the newest page of history and attaches to the run's stream. How a
 * run is followed (sync, attach, beats) is pinned in `stores/__tests__/
 * chat-live-*.test.ts`; this file tests the translation and how it meets the
 * panel's lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t } from '@breatic/shared';
import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';

const toastSpy = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast: { warning: toastSpy.warning, error: toastSpy.error, success: vi.fn(), info: vi.fn() } }));
import { renderHook, waitFor, act } from '@testing-library/react';
import type * as ChatApiModule from '@web/data/api/chat';
import type * as AssetsApiModule from '@web/data/api/assets';

vi.mock('@web/data/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatApiModule>();
  return {
    ...actual,
    chatApi: {
      streamConfig: vi.fn(async () => ({ heartbeatIntervalMs: 5000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3_000 })),
      openChat: vi.fn(),
      messagesBefore: vi.fn(),
      readConversation: vi.fn(),
      listConversations: vi.fn(),
      createConversation: vi.fn(),
      renameConversation: vi.fn(),
      deleteConversation: vi.fn(),
      running: vi.fn(async () => []),
      sync: vi.fn(),
      sendMessage: vi.fn(),
      stop: vi.fn(async () => ({ stopped: true })),
      removeQueued: vi.fn(),
      streamPath: actual.chatApi.streamPath,
    },
  };
});

// Chat sends every body through bodyOrTransfer, which first asks for the
// upload config. Answer it here with the shipped request-body limit, so the
// real threshold runs (these bodies are small and go as they are) and no
// request reaches the network, where fake timers would never settle it.
vi.mock('@web/data/api/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsApiModule>();
  return {
    ...actual,
    assetsApi: {
      ...actual.assetsApi,
      fetchUploadConfig: async () => ({
        maxUploadBytes: 2 * 1024 * 1024 * 1024,
        clientMaxAttempts: 3,
        clientRetryBaseDelayMs: 1000,
        uploadIdleTimeoutMs: 30_000,
        assetUrlPrefix: 'https://assets.test.invalid/',
        uploadStatusPollSeconds: 5,
        maxRequestBodyBytes: 1048576,
      }),
    },
  };
});

import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { _resetForTests, conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';
import { tell } from '@web/stores/chat-mishaps';
import { evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetChatLiveForTests } from '@web/stores/chat-live';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { replyOpens, storesWhatIsDrawn, stubRunWire } from '@web/test-utils/chat-run-wire';
import { chatSessionFor } from '@web/stores/chat-sessions';
import type { RunWire } from '@web/test-utils/chat-run-wire';

/** The limits the server reads, as `GET /chat/stream-config` answers them. */
const LIMITS = {
  heartbeatIntervalMs: 5000,
  attachmentMaxChars: 200_000,
  attachmentMaxItems: 10,
  currentSpaceMaxChars: 100_000,
  spaceListMaxItems: 200,
  spaceReadTimeoutMs: 20_000,
  runningPollIntervalMs: 5000,
  syncIntervalMs: 3_000,
};

/** A sync answered while nothing holds the conversation. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** A send the server answered by opening a run for it. */
const STARTED: ChatSendAnswer = { status: 'start', pending: [], running: true };

/** The run streams the page reads. */
let wire: RunWire;

/** What the server holds for c-1, as both opening the chat and reading it back answer. */
let stored: StoredUiMessage[] = [];

/**
 * A stored message.
 * @param id - Its id.
 * @param role - Who said it.
 * @param text - What it says.
 * @param turn - Its turn.
 * @returns The message.
 */
function row(id: string, role: 'user' | 'assistant', text: string, turn = 1): StoredUiMessage {
  return { id, role, parts: [{ type: 'text', text }], metadata: { turnIndex: turn, ts: '2026-08-11T00:00:00Z' } } as StoredUiMessage;
}

/**
 * What the server says this conversation holds when the chat is opened.
 * @param messages - What was said in it.
 * @param conversationId - Which conversation.
 */
function openChatAnswers(
  messages: Array<{ id: string; role: 'user' | 'assistant'; text: string }>,
  conversationId = 'c-1',
): void {
  stored = messages.map((m) => row(m.id, m.role, m.text));
  vi.mocked(chatApi.openChat).mockResolvedValue({
    conversations: [{ id: conversationId }],
    current: {
      conversation: { id: conversationId, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
      messages: stored,
      hasMore: false,
    },
  } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);
}

/**
 * The bodies the page sent, in order.
 * @returns Each body.
 */
function sent(): Array<Record<string, unknown>> {
  return vi.mocked(chatApi.sendMessage).mock.calls.map((call) => call[0] as Record<string, unknown>);
}

/**
 * Render the hook.
 * @returns What renderHook returns.
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>> {
  return renderHook(() => useChatSession('p-1', () => ({ spaces: [] })));
}

/**
 * Render the panel and wait for it to read the conversation back and ask the
 * server where it stands.
 * @returns What renderHook returns.
 */
async function anOpenPanel(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>>
  > {
  const panel = render();
  await waitFor(() => {
    expect(panel.result.current.status).toBe('ready');
  });
  await waitFor(() => {
    expect(chatApi.sync).toHaveBeenCalled();
  });
  return panel;
}

/**
 * Send something, and wait for the run it opened to start streaming: the
 * server holds the message, the newest page of history (which has it) is
 * read back, and the run's stream is attached to.
 * @param panel - The panel.
 * @param said - What was said.
 */
async function aReplyStartsArriving(
  panel: ReturnType<typeof render>,
  said = 'find a few reference images',
): Promise<void> {
  const streamsBefore = wire.streams().length;
  stored = [...stored, row('sent-1', 'user', said, 2)];
  act(() => {
    void panel.result.current.send(said);
  });
  await waitFor(() => {
    expect(wire.streams().length).toBe(streamsBefore + 1);
  });
  act(() => {
    for (const chunk of replyOpens()) wire.last()?.push(chunk);
  });
  await waitFor(() => {
    expect(panel.result.current.turnPhase).toBe('running');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The module singletons outlive every case in this file, the same way they
  // outlive the panel.
  _resetForTests();
  evictAllChatSessions();
  wire = stubRunWire();
  openChatAnswers([]);
  vi.mocked(chatApi.readConversation).mockImplementation(async (id: string) => ({
    conversation: { id, agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
    messages: stored,
    hasMore: false,
  }) as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
  vi.mocked(chatApi.sync).mockResolvedValue(IDLE);
  vi.mocked(chatApi.sendMessage).mockResolvedValue(STARTED);
});

afterEach(() => {
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.unstubAllGlobals();
  // Here rather than at the end of a case: a case that times out under a fake
  // clock never reaches that line, and every later one would then run on it
  // while `waitFor` polls on real timers.
  vi.useRealTimers();
});

describe('what the panel shows when it opens', () => {
  it('asks the server once and shows what it says', async () => {
    openChatAnswers([
      { id: 'm1', role: 'user', text: 'asked before' },
      { id: 'm2', role: 'assistant', text: 'answered before' },
    ]);

    const panel = await anOpenPanel();

    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(panel.result.current.messages.map((m) => m.content)).toEqual([
      'asked before',
      'answered before',
    ]);
  });

  it('shows nothing until the server has answered', () => {
    vi.mocked(chatApi.openChat).mockReturnValue(new Promise(() => {}));

    const panel = render();

    expect(panel.result.current.status).toBe('loading');
    expect(panel.result.current.messages).toEqual([]);
  });

  it('asks the server nothing when the conversation is already loaded', async () => {
    openChatAnswers([{ id: 'm1', role: 'user', text: 'asked before' }]);
    const first = await anOpenPanel();
    first.unmount();

    const second = await anOpenPanel();

    // All asking again could learn is the half the server does not know yet --
    // which is the only thing on screen it would push out.
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
    expect(second.result.current.messages.map((m) => m.content)).toEqual(['asked before']);
  });
});

describe('a reply as the panel draws it', () => {
  it('grows in one place as the pieces arrive', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    for (const delta of ['Sure', ', I', ' will look']) {
      act(() => {
        wire.last()?.push({ type: 'text-delta', id: 't1', delta });
      });
    }

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('Sure, I will look');
    });
    // One, not three. A bubble per piece is one answer cut into a string of them.
    expect(panel.result.current.messages).toHaveLength(2);
  });

  it('is marked as being written, so the bubble can say so', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.streaming).toBe(true);
    });
  });

  it('stops being marked when the turn is over', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });

    act(() => {
      wire.last()?.push({ type: 'text-end', id: 't1' });
      wire.last()?.push({ type: 'finish-step' });
      wire.last()?.push({ type: 'finish' });
      wire.last()?.close();
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('idle');
    });
    expect(panel.result.current.messages.at(-1)?.streaming).toBeUndefined();
  });

  it('collects the thinking onto the reply it belongs to', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    act(() => {
      wire.last()?.push({ type: 'reasoning-start', id: 'r1' });
      wire.last()?.push({ type: 'reasoning-delta', id: 'r1', delta: 'Think first' });
      wire.last()?.push({ type: 'reasoning-delta', id: 'r1', delta: ' about the style' });
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.thinking).toBe('Think first about the style');
    });
    // Thinking and text are two things, drawn apart. Mixed into the text the
    // user would read the model's draft.
    expect(panel.result.current.messages.at(-1)?.content).toBe('Sure');
  });

  it('hands back the same object for every message that did not change', async () => {
    openChatAnswers([{ id: 'm1', role: 'user', text: 'asked before' }]);
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'S' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('S');
    });
    const settledBefore = panel.result.current.messages[0];

    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'ure' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('Sure');
    });

    // Rebuilding the whole list on every piece hands React every bubble as
    // new -- dozens of times a second, the whole column redrawn.
    expect(panel.result.current.messages[0]).toBe(settledBefore);
  });
});

describe('a reply resumed after a questionnaire (inner#1542)', () => {
  it('hands back the same object for the answered part while the rest streams', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    const input = { questions: [{ header: 'Ratio', question: 'Which ratio?', multiSelect: false, options: [{ label: '16:9' }, { label: '9:16' }] }] };
    act(() => {
      wire.last()?.push({ type: 'tool-input-available', toolCallId: 'ask-1', toolName: 'ask_user', input });
      wire.last()?.push({ type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } });
      wire.last()?.push({ type: 'tool-output-available', toolCallId: 'ask-1', output: { answers: [{ index: 0, selected: ['9:16'] }] } });
      wire.last()?.push({ type: 'text-start', id: 't2' });
      wire.last()?.push({ type: 'text-delta', id: 't2', delta: 'Here' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('Here');
    });
    const answered = panel.result.current.messages.at(-2);
    expect(answered?.questionnaires?.[0]?.state).toBe('answered');

    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't2', delta: ' it is' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('Here it is');
    });

    expect(panel.result.current.messages.at(-2)).toBe(answered);
  });
});

describe('a turn that failed', () => {
  it('is marked on the reply, and marked as happening now, when the stream says it failed (RW-17)', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages).toHaveLength(2);
    });
    storesWhatIsDrawn(() => chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined }).messages, 'c-1');

    act(() => {
      wire.last()?.push({ type: 'data-failed', data: { reason: 'model' } });
      wire.last()?.push({ type: 'error', errorText: 'The assistant could not finish this turn.' });
      wire.last()?.close();
    });

    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.failed).toBe(true);
    });
    // A failure the user is living through is told; the failed turns in the
    // history must not be -- opening the panel would read them all out.
    expect(panel.result.current.messages.at(-1)?.failedJustNow).toBe(true);
  });

  it('is not marked from an error frame alone: the mark comes only from the server (RW-17)', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'Sure' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages).toHaveLength(2);
    });

    act(() => {
      wire.last()?.push({ type: 'error', errorText: 'The assistant could not finish this turn.' });
      wire.last()?.close();
    });

    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('idle');
    });
    expect(panel.result.current.messages.at(-1)?.failed).toBeFalsy();
  });

  it('is read back out of the history without being announced again', async () => {
    stored = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'half a sentence' }, { type: 'data-failed', data: null }],
        metadata: { turnIndex: 1, ts: '2026-08-11T00:00:00Z' },
      } as StoredUiMessage,
    ];
    vi.mocked(chatApi.openChat).mockResolvedValue({
      conversations: [{ id: 'c-1' }],
      current: {
        conversation: { id: 'c-1', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
        messages: stored,
        hasMore: false,
      },
    } as unknown as Awaited<ReturnType<typeof chatApi.openChat>>);

    const panel = await anOpenPanel();

    expect(panel.result.current.messages.at(-1)?.failed).toBe(true);
    expect(panel.result.current.messages.at(-1)?.failedJustNow).toBeUndefined();
  });
});

describe('a turn the user stopped', () => {
  it('asks the server to stop it and marks the reply the way the stream says (RW-18)', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'half a sentence' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages).toHaveLength(2);
    });
    storesWhatIsDrawn(() => chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined }).messages, 'c-1');

    act(() => {
      panel.result.current.abort();
    });

    await waitFor(() => {
      expect(chatApi.stop).toHaveBeenCalledWith('c-1', 'p-1', undefined);
    });
    // The page does not stop reading: the stream goes on to the end the server writes.
    expect(wire.last()?.abandoned()).toBe(false);
    act(() => {
      wire.last()?.push({ type: 'data-interrupted', data: {} });
      wire.last()?.push({ type: 'finish' });
      wire.last()?.close();
    });

    // Without the mark the same message reads as finished, and only becomes
    // "interrupted" after a refresh.
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.interrupted).toBe(true);
    });
    expect(panel.result.current.turnPhase).toBe('idle');
  });
});

describe('what the panel says went wrong (inner#1530)', () => {
  beforeEach(() => {
    toastSpy.error.mockClear();
  });

  it('says it in a toast, in the words that fit what happened', async () => {
    await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' });
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'turn' });
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'gone' });
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'server', message: 'Too long.' });
    });

    expect(toastSpy.error.mock.calls.map((call) => call[0])).toEqual([
      t('chat.error.network'),
      t('chat.error.turnFailed'),
      t('chat.conversation.gone'),
      'Too long.',
    ]);
  });

  it('says nothing about another conversation in the background (RW-10)', async () => {
    await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-other', kind: 'network' });
    });

    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('says it anyway when the user did it on purpose', async () => {
    await anOpenPanel();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-other', deliberate: true, kind: 'network' });
    });

    expect(toastSpy.error).toHaveBeenCalledTimes(1);
  });

  it('says a word about a row the same way as any other', async () => {
    const open = render();
    await waitFor(() => {
      expect(open.result.current.status).toBe('ready');
    });

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-2', deliberate: true, kind: 'network' });
    });

    expect(toastSpy.error).toHaveBeenCalledWith(t('chat.error.network'));
  });

  it('is not held for a user who was not looking', async () => {
    const panel = await anOpenPanel();
    panel.unmount();

    act(() => {
      tell({ projectId: 'p-1', conversationId: 'c-1', kind: 'network' });
    });
    await anOpenPanel();

    expect(toastSpy.error).not.toHaveBeenCalled();
  });
});

describe('when the panel goes away mid-stream', () => {
  it('leaves the turn running, because collapsing the column is not leaving', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);

    panel.unmount();

    // The run is the server's: the page lets go of its stream and asks nothing to stop.
    await waitFor(() => {
      expect(wire.last()?.abandoned()).toBe(true);
    });
    expect(chatApi.stop).not.toHaveBeenCalled();
  });

  it('shows the same reply, still being written, when the column is opened again', async () => {
    const panel = await anOpenPanel();
    await aReplyStartsArriving(panel);
    act(() => {
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'halfway through' });
    });
    await waitFor(() => {
      expect(panel.result.current.messages.at(-1)?.content).toBe('halfway through');
    });
    panel.unmount();
    vi.mocked(chatApi.sync).mockResolvedValue({ ...IDLE, running: true });

    const back = render();
    // Coming back reads the run again from its start.
    await waitFor(() => {
      expect(wire.streams()).toHaveLength(2);
    });
    act(() => {
      for (const chunk of replyOpens()) wire.last()?.push(chunk);
      wire.last()?.push({ type: 'text-delta', id: 't1', delta: 'halfway through' });
    });

    await waitFor(() => {
      expect(back.result.current.messages.at(-1)?.content).toBe('halfway through');
    });
    expect(back.result.current.turnPhase).toBe('running');
    // Replayed from the start and drawn once.
    expect(back.result.current.messages).toHaveLength(2);
  });
});

describe('when the chat never opened', () => {
  it('looks like an empty conversation, because that is what is on screen', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValue(new Error('offline'));

    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('failed');
    });

    expect(panel.result.current.messages).toEqual([]);
    expect(panel.result.current.currentId).toBeUndefined();
  });

  it('starts a conversation when the user sends anyway', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('failed');
    });
    openChatAnswers([]);

    act(() => {
      void panel.result.current.send('asking anyway');
    });

    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
    expect(sent()[0]).toMatchObject({ conversation_id: 'c-1', message: 'asking anyway' });
  });
});

describe('a send the server refused (#1363)', () => {
  /**
   * Refuse the next send the way the server refuses a model it no longer has.
   */
  function refuseTheModel(): void {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 422, message: 'The selected model is no longer available.', fromServer: true }),
    );
  }

  it('is counted, so the model picker asks for the list again', async () => {
    const panel = await anOpenPanel();
    const before = useConversationRuntime.getState().modelListAsks;
    refuseTheModel();

    act(() => {
      void panel.result.current.send('hello');
    });

    await waitFor(() => {
      expect(useConversationRuntime.getState().modelListAsks).toBe(before + 1);
    });
  });

  it('is counted in a conversation the send itself opened', async () => {
    vi.mocked(chatApi.openChat).mockRejectedValueOnce(new Error('offline'));
    const panel = render();
    await waitFor(() => {
      expect(panel.result.current.status).toBe('failed');
    });
    openChatAnswers([]);
    const before = useConversationRuntime.getState().modelListAsks;
    refuseTheModel();

    act(() => {
      void panel.result.current.send('hello');
    });

    await waitFor(() => {
      expect(useConversationRuntime.getState().modelListAsks).toBe(before + 1);
    });
  });
});

describe('the Spaces a message carries (inner#1413)', () => {
  const read = {
    spaces: [
      { id: 's3', name: 'Edit', kind: 'timeline' as const },
      { id: 's2', name: 'Storyboard', kind: 'document' as const },
      { id: 's1', name: 'Cast', kind: 'canvas' as const },
    ],
    current: {
      id: 's2',
      name: 'Storyboard',
      kind: 'document' as const,
      state: 'loaded' as const,
      blocks: [{ id: 'b1', type: 'paragraph', markdown: 'abcdef', text: 'abcdef', lossy: false }],
    },
  };

  /**
   * Render the panel with these Spaces and wait until it has synced, so the
   * next read of the limits is the send's.
   * @param readSpaces - How the Spaces are read.
   * @returns What renderHook returns.
   */
  async function aPanelReading(readSpaces: () => typeof read): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, unknown>>> {
    const panel = renderHook(() => useChatSession('p-1', readSpaces));
    await waitFor(() => {
      expect(panel.result.current.status).toBe('ready');
    });
    await waitFor(() => {
      expect(chatApi.sync).toHaveBeenCalled();
    });
    return panel;
  }

  it('reads them at the press, before anything is waited on', async () => {
    const readSpaces = vi.fn(() => read);
    const panel = await aPanelReading(readSpaces);

    act(() => {
      void panel.result.current.send('summarise this');
      expect(readSpaces).toHaveBeenCalledTimes(1);
    });
  });

  it('sends them cut to the limits the server reads', async () => {
    const panel = await aPanelReading(() => read);
    vi.mocked(chatApi.streamConfig).mockResolvedValueOnce({ ...LIMITS, currentSpaceMaxChars: 16, spaceListMaxItems: 2 });

    act(() => {
      void panel.result.current.send('summarise this');
    });
    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });

    expect(sent()[0]).toMatchObject({
      message: 'summarise this',
      spaces: [{ id: 's3' }, { id: 's2' }],
      spaces_total: 3,
      current_space: { id: 's2', state: 'loaded', content: '<!-- b:1 -->\nabc', total_chars: 19 },
    });
  });

  it('sends nothing and says so in a toast when the limits cannot be read', async () => {
    const panel = await aPanelReading(() => read);
    vi.mocked(chatApi.streamConfig).mockRejectedValueOnce(new Error('offline'));
    act(() => {
      panel.result.current.setDraft('summarise this');
    });

    await act(async () => {
      await panel.result.current.send('summarise this');
    });

    expect(sent()).toHaveLength(0);
    expect(toastSpy.warning).toHaveBeenCalledWith('Couldn’t send right now. Try again.');
    expect(panel.result.current.draft).toBe('summarise this');
  });
});

describe('the wait for the limits before a send (inner#1413)', () => {
  it('holds the send between the press and the request while the limits are read', async () => {
    const panel = await anOpenPanel();
    let answer: (config: Awaited<ReturnType<typeof chatApi.streamConfig>>) => void = () => undefined;
    vi.mocked(chatApi.streamConfig).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    act(() => {
      void panel.result.current.send('summarise this');
    });
    await waitFor(() => {
      expect(panel.result.current.turnPhase).toBe('sending');
    });
    expect(sent()).toHaveLength(0);

    act(() => {
      answer(LIMITS);
    });
    await waitFor(() => {
      expect(sent()).toHaveLength(1);
    });
  });

  it('sends nothing into the conversation being left when a new one is started during the wait', async () => {
    vi.mocked(chatApi.createConversation).mockReturnValue(new Promise(() => {}));
    const panel = await anOpenPanel();
    let answer: (config: Awaited<ReturnType<typeof chatApi.streamConfig>>) => void = () => undefined;
    vi.mocked(chatApi.streamConfig).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    act(() => {
      void panel.result.current.send('summarise this');
    });
    act(() => {
      void conversationRuntime.startNew('p-1');
    });
    await act(async () => {
      answer(LIMITS);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(sent().filter((body) => body.conversation_id === 'c-1')).toHaveLength(0);
  });

  /**
   * Press send while the limits are still on their way.
   * @returns Answers the limits read.
   */
  async function pressWhileTheLimitsAreRead(): Promise<() => Promise<void>> {
    const panel = await anOpenPanel();
    let answer: (config: Awaited<ReturnType<typeof chatApi.streamConfig>>) => void = () => undefined;
    vi.mocked(chatApi.streamConfig).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    act(() => {
      void panel.result.current.send('summarise this');
    });
    return async () => {
      await act(async () => {
        answer(LIMITS);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    };
  }

  it('sends nothing once the user has left the project during the wait', async () => {
    const answerTheLimits = await pressWhileTheLimitsAreRead();

    act(() => {
      conversationRuntime.leaveProject('p-1');
    });
    await answerTheLimits();

    expect(sent()).toHaveLength(0);
    expect(chatApi.openChat).toHaveBeenCalledTimes(1);
  });

  it('sends nothing into the conversation the user switched to during the wait', async () => {
    vi.mocked(chatApi.readConversation).mockResolvedValue({
      conversation: { id: 'c-2', agentModel: { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' } },
      messages: [],
      hasMore: false,
    } as unknown as Awaited<ReturnType<typeof chatApi.readConversation>>);
    const answerTheLimits = await pressWhileTheLimitsAreRead();

    await act(async () => {
      await conversationRuntime.switchTo('p-1', 'c-2');
    });
    await answerTheLimits();

    expect(sent()).toHaveLength(0);
  });
});
