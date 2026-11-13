// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the user does to a conversation's run beside sending (inner#1717):
 * answering a card, pressing stop, and taking a waiting message back. Each is
 * a request of its own that waits for the server and acts on its answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatPendingItem, ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests, useChatLive } from '@web/stores/chat-live';
import { chatWaiting, useChatWaiting } from '@web/stores/chat-waiting';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { chatAttachments } from '@web/stores/chat-attachments';
import { watchChatMishaps, type ChatMishap } from '@web/stores/chat-mishaps';
import { replyOpens, settle, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** A paused reply holding a questionnaire that waits. */
const PAUSED: StoredUiMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'tool-ask_user', toolCallId: 'ask-1', state: 'input-available', input: {} } as never],
  metadata: { turnIndex: 1 } as never,
};

/** A waiting message. */
const M1: ChatPendingItem = {
  id: 'm1',
  sentAt: '2026-11-12T08:00:00.000Z',
  words: 'first thought',
  chips: [{ id: 'chip-1', type: 'text', name: 'notes.txt', data_snapshot: { text: 'n' } }],
};

let wire: RunWire;
let told: ChatMishap[];
let unwatch: () => void;

/**
 * A refusal as axios hands it over.
 * @param status - The HTTP status.
 * @param details - The server's `error` body.
 * @returns The exception.
 */
function refused(status: number, details: Record<string, unknown> = {}): ApiException {
  return new ApiException({ status, message: `refused ${String(status)}`, fromServer: true, details, reason: details.reason as string | undefined });
}

/**
 * The conversation's messages.
 * @returns The messages.
 */
function messages(): StoredUiMessage[] {
  return chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [], onTitled: () => {} }).messages;
}

/**
 * Answer the questionnaire.
 * @returns When the answer is settled.
 */
function answer(): Promise<void> {
  return chatLive.answerCard({
    projectId: 'p1',
    conversationId: 'c1',
    toolCallId: 'ask-1',
    card: { answer: { toolCallId: 'ask-1', answers: [{ index: 0, selected: ['9:16'] }] } },
    spaces: {},
  });
}

beforeEach(() => {
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 1000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue({ conversation: { id: 'c1' } as never, messages: [PAUSED], hasMore: false });
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'start', pending: [], running: true });
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
  vi.spyOn(chatApi, 'removeQueued').mockResolvedValue('removed');
  told = [];
  unwatch = watchChatMishaps((m) => told.push(m));
  chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [PAUSED], onTitled: () => {} });
  chatLive.show('p1', 'c1');
});

afterEach(() => {
  unwatch();
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
});

describe('the answer to a card', () => {
  it('goes to the conversation with the card, and attaches to the run it resumes (WB-32 start)', async () => {
    await settle();
    await answer();
    await settle();
    expect(vi.mocked(chatApi.sendMessage).mock.calls[0]![0]).toMatchObject({
      message: '',
      project_id: 'p1',
      conversation_id: 'c1',
      answer: { toolCallId: 'ask-1', answers: [{ index: 0, selected: ['9:16'] }] },
    });
    expect(wire.streams()).toHaveLength(1);
  });

  it('reads the history again and attaches to nothing when no run is running for it (WB-33)', async () => {
    await settle();
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce({ status: 'start', pending: [], running: false });
    const reads = vi.mocked(chatApi.readConversation).mock.calls.length;
    await answer();
    await settle();
    expect(vi.mocked(chatApi.readConversation).mock.calls.length).toBe(reads + 1);
    expect(wire.streams()).toHaveLength(0);
  });

  it('draws the card answered when the server says it already was (WB-32 409 success)', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(409, { code: 409, call: { status: 'success', output: { answers: [] } } }));
    await answer();
    const part = messages()[0]!.parts[0] as { state: string; output: unknown };
    expect(part).toMatchObject({ state: 'output-available', output: { answers: [] } });
    expect(told).toEqual([]);
  });

  for (const [what, err] of [
    ['409 not success', refused(409, { code: 409, call: { status: 'error', output: null } })],
    ['409 turn_busy', refused(409, { code: 409, reason: 'turn_busy' })],
    ['503 shutting_down', refused(503, { code: 503, reason: 'shutting_down' })],
    ['404', refused(404)],
    ['422', refused(422)],
    ['402', refused(402)],
  ] as const) {
    it(`leaves the card waiting and tells the server's sentence: ${what} (WB-32)`, async () => {
      vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(err);
      await answer();
      expect((messages()[0]!.parts[0] as { state: string }).state).toBe('input-available');
      expect(told).toContainEqual(expect.objectContaining({ kind: 'server', message: err.message }));
    });
  }

  it('draws a failed ending from the stream when a shutdown stopped the run it resumed (WB-34)', async () => {
    await settle();
    await answer();
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'data-failed', data: { reason: 'shutdown' } });
    s.push({ type: 'error', errorText: 'x' });
    await settle();
    expect(messages().at(-1)!.parts.filter((p) => p.type === 'data-failed')).toHaveLength(1);
  });
});

describe('pressing stop', () => {
  it('asks the server to stop the run, waiting meanwhile, and reads on until the stream ends (WB-26)', async () => {
    let answerStop!: (a: { stopped: boolean }) => void;
    vi.mocked(chatApi.stop).mockImplementationOnce(() => new Promise((r) => {
      answerStop = r;
    }));
    await settle();
    chatLive.hide('c1');
    vi.mocked(chatApi.sync).mockResolvedValueOnce({ ...IDLE, running: true });
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    const stopping = chatLive.stop('p1', 'c1');
    await settle();
    expect(chatApi.stop).toHaveBeenCalledWith('c1', 'p1', undefined);
    expect(useChatLive.getState().stopping.c1).toBe(true);
    expect(s.abandoned()).toBe(false);
    answerStop({ stopped: true });
    await stopping;
    expect(useChatLive.getState().stopping.c1).toBeUndefined();
    s.push({ type: 'data-interrupted', data: {} });
    s.close();
    await settle();
    expect(messages().at(-1)!.parts.filter((p) => p.type === 'data-interrupted')).toHaveLength(1);
  });
});

describe('taking a waiting message back', () => {
  beforeEach(() => {
    chatWaiting.fromSend('c1', [M1]);
    conversationRuntime.setDraft('c1', 'old');
    vi.spyOn(chatAttachments, 'add');
  });

  it('puts its words ahead of the draft and its items back above the box, once the server took it out (WB-20)', async () => {
    let answerRemove!: (status: 'removed') => void;
    vi.mocked(chatApi.removeQueued).mockImplementationOnce(() => new Promise((r) => {
      answerRemove = r;
    }));
    const taking = chatLive.takeBack('p1', 'c1', M1, 'retract');
    await settle();
    expect(useChatWaiting.getState().byConversation.c1?.busy).toEqual({ m1: 'retract' });
    answerRemove('removed');
    await taking;
    expect(chatApi.removeQueued).toHaveBeenCalledWith('c1', 'm1', 'p1');
    expect(conversationRuntime.draftOf('c1').startsWith('first thought')).toBe(true);
    expect(conversationRuntime.draftOf('c1').endsWith('old')).toBe(true);
    expect(chatAttachments.add).toHaveBeenCalledWith('c1', [expect.objectContaining({ id: 'chip-1', status: 'ready', chip: M1.chips[0] })], expect.anything());
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ pending: [], busy: {} });
  });

  it('drops a deleted one without touching the box (WB-21 delete)', async () => {
    await chatLive.takeBack('p1', 'c1', M1, 'delete');
    expect(conversationRuntime.draftOf('c1')).toBe('old');
    expect(chatAttachments.add).not.toHaveBeenCalled();
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([]);
  });

  it('keeps one a run already took (WB-21 taken)', async () => {
    vi.mocked(chatApi.removeQueued).mockResolvedValueOnce('taken');
    await chatLive.takeBack('p1', 'c1', M1, 'retract');
    expect(conversationRuntime.draftOf('c1')).toBe('old');
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([M1]);
  });

  it('drops one another page already handled, without touching the box (WB-21 gone)', async () => {
    vi.mocked(chatApi.removeQueued).mockResolvedValueOnce('gone');
    await chatLive.takeBack('p1', 'c1', M1, 'retract');
    expect(conversationRuntime.draftOf('c1')).toBe('old');
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([]);
  });

  it('keeps it and tells why when the request fails (WB-21 failed)', async () => {
    vi.mocked(chatApi.removeQueued).mockRejectedValueOnce(refused(500));
    await chatLive.takeBack('p1', 'c1', M1, 'delete');
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ pending: [M1], busy: {} });
    expect(told).toContainEqual(expect.objectContaining({ kind: 'server', message: 'refused 500' }));
  });
});
