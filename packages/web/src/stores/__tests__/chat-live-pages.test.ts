// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a page shows of a run another page set going or acted on (inner#1717):
 * each page reads the server's stream itself, so a card answered elsewhere is
 * drawn answered, a stop pressed on one page is drawn on both, a message sent
 * from one page is followed by the other at its next sync, and a message sent
 * while a card waits lands in the order the server keeps.
 *
 * A page is one copy of the modules, as each browser tab has its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSyncAnswer } from '@breatic/shared';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { replyEnds, replyOpens, settle, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };
const RUNNING: ChatSyncAnswer = { ...IDLE, running: true };

/** One browser tab's copy of the chat modules. */
interface Page {
  api: (typeof import('@web/data/api/chat'))['chatApi'];
  live: typeof import('@web/stores/chat-live');
  sessions: typeof import('@web/stores/chat-sessions');
  /** The conversation's messages as this page holds them. */
  messages: () => StoredUiMessage[];
}

let wire: RunWire;
const pages: Page[] = [];

/**
 * A stored user message.
 * @param id - Its id.
 * @param turn - Its turn.
 * @returns The message.
 */
function userRow(id: string, turn: number): StoredUiMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: `said ${id}` }], metadata: { turnIndex: turn } as never };
}

/**
 * The reply paused at a questionnaire.
 * @param card - The card part's state and output.
 * @returns The reply.
 */
function pausedReply(card: Record<string, unknown>): StoredUiMessage {
  return {
    id: 'a0',
    role: 'assistant',
    parts: [{ type: 'tool-ask_user', toolCallId: 'ask-1', input: {}, ...card } as never],
    metadata: { turnIndex: 1 } as never,
  };
}

/** The card as it waits for the user. */
const WAITING = { state: 'input-available' };

/**
 * A page of history.
 * @param messages - What it holds.
 * @returns The answer.
 */
function page(messages: StoredUiMessage[]): ConversationRead {
  return { conversation: { id: 'c1' } as never, messages, hasMore: false };
}

/**
 * Open a page on conversation c1.
 * @param history - What the page holds when it opens.
 * @param read - What reading the history back answers.
 * @param syncs - What its syncs answer, in turn; the last one from then on.
 * @returns The page.
 */
async function openPage(history: StoredUiMessage[], read: StoredUiMessage[], syncs: ChatSyncAnswer[]): Promise<Page> {
  vi.resetModules();
  const { chatApi } = await import('@web/data/api/chat');
  const live = await import('@web/stores/chat-live');
  const sessions = await import('@web/stores/chat-sessions');
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 1000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue(page(read));
  const sync = vi.spyOn(chatApi, 'sync');
  for (const answer of syncs.slice(0, -1)) sync.mockResolvedValueOnce(answer);
  sync.mockResolvedValue(syncs.at(-1)!);
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'start', pending: [], running: true });
  const init = { projectId: 'p1', conversationId: 'c1', history, onTitled: (): void => {} };
  sessions.chatSessionFor(init);
  const opened: Page = { api: chatApi, live, sessions, messages: () => sessions.chatSessionFor(init).messages };
  pages.push(opened);
  return opened;
}

/**
 * The ids of the user's messages, in the order the page draws them: rows of
 * their own and those a reply took in.
 * @param messages - The page's messages.
 * @returns The ids.
 */
function userMessageOrder(messages: StoredUiMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === 'user'
      ? [m.id]
      : m.parts.filter((p) => p.type === 'data-user-message').map((p) => (p as { data: { id: string } }).data.id),
  );
}

beforeEach(() => {
  wire = stubRunWire();
});

afterEach(() => {
  for (const p of pages.splice(0)) {
    p.live.resetChatLiveForTests();
    p.sessions.evictAllChatSessions();
  }
  vi.restoreAllMocks();
});

describe('a card another page answered', () => {
  it('is drawn answered here before the run it resumed is read (WB-19)', async () => {
    const answered = { state: 'output-available', output: { answers: [{ index: 0, selected: ['9:16'] }] } };
    const here = await openPage([userRow('u0', 1), pausedReply(WAITING)], [userRow('u0', 1), pausedReply(answered)], [RUNNING, IDLE]);
    here.live.chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens('t2')) s.push(f);
    s.push({ type: 'text-delta', id: 't2', delta: 'Going with 9:16.' });
    await settle();
    expect(here.messages().map((m) => m.id)).toEqual(['u0', 'a0']);
    expect(here.messages()[1]!.parts[0]).toMatchObject(answered);
  });
});

describe('a stop pressed on one of two pages reading the run', () => {
  it('is drawn interrupted on both, from the frame the server writes (WB-27)', async () => {
    const a = await openPage([userRow('u0', 1)], [userRow('u0', 1)], [RUNNING, IDLE]);
    a.live.chatLive.show('p1', 'c1');
    await settle();
    const b = await openPage([userRow('u0', 1)], [userRow('u0', 1)], [RUNNING, IDLE]);
    b.live.chatLive.show('p1', 'c1');
    await settle();
    const streams = wire.streams();
    expect(streams).toHaveLength(2);
    for (const s of streams) for (const f of replyOpens()) s.push(f);
    await settle();

    await a.live.chatLive.stop('p1', 'c1');
    expect(a.api.stop).toHaveBeenCalledWith('c1', 'p1');
    expect(b.api.stop).not.toHaveBeenCalled();
    for (const s of streams) {
      s.push({ type: 'data-interrupted', data: {} });
      s.close();
    }
    await settle();

    for (const p of [a, b]) {
      expect(p.messages().at(-1)!.parts.filter((part) => part.type === 'data-interrupted')).toHaveLength(1);
    }
  });
});

describe('a message sent from one of two idle pages', () => {
  it('is followed by the other page once its next sync says a run holds the conversation (WB-41)', async () => {
    const b = await openPage([userRow('u0', 1)], [userRow('u0', 1), userRow('m1', 2)], [IDLE]);
    b.live.chatLive.show('p1', 'c1');
    await settle();
    const a = await openPage([userRow('u0', 1)], [userRow('u0', 1), userRow('m1', 2)], [{ ...IDLE, next_sync_ms: 300 }, RUNNING, IDLE]);
    a.live.chatLive.show('p1', 'c1');
    await settle();
    expect(wire.streams()).toHaveLength(0);

    await b.live.chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'make it blue', chips: [], spaces: {} });
    await settle();
    expect(wire.streams()).toHaveLength(1);

    expect(a.api.sync).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 350));
    await settle();
    expect(wire.streams()).toHaveLength(2);
    const onA = wire.last()!;
    for (const f of replyOpens()) onA.push(f);
    onA.push({ type: 'text-delta', id: 't1', delta: 'Blue it is.' });
    for (const f of replyEnds()) onA.push(f);
    onA.close();
    await settle();
    expect(a.messages().map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(a.messages().at(-1)!.parts.at(-1)).toMatchObject({ type: 'text', text: 'Blue it is.' });
  });
});

describe('a message sent while a card waits', () => {
  /** The card as a message sent instead of an answer closes it. */
  const CLOSED = { state: 'output-available', output: { repliedInChat: true } };

  it('closes the card and opens the run when nothing else waits (WB-43, queue empty)', async () => {
    const here = await openPage(
      [userRow('u0', 1), pausedReply(WAITING)],
      [userRow('u0', 1), pausedReply(CLOSED), userRow('m1', 2)],
      [{ ...IDLE, awaiting: true }],
    );
    here.live.chatLive.show('p1', 'c1');
    await settle();
    await here.live.chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'something else', chips: [], spaces: {} });
    await settle();
    const s = wire.last()!;
    s.push({ type: 'data-ask-replied', data: { toolCallId: 'ask-1' } });
    for (const f of replyOpens()) s.push(f);
    await settle();
    expect(here.messages()[1]!.parts[0]).toMatchObject(CLOSED);
    expect(userMessageOrder(here.messages())).toEqual(['u0', 'm1']);
  });

  it('draws the ones queued before it first, then it, as the server keeps them (WB-43, queue not empty)', async () => {
    const queued = { id: 'm1', sentAt: '2026-11-12T08:00:00.000Z', words: 'said m1', chips: [] };
    const here = await openPage(
      [userRow('u0', 1), pausedReply(WAITING)],
      [userRow('u0', 1), pausedReply(CLOSED), userRow('m1', 2)],
      [{ ...IDLE, awaiting: true, pending: [queued] }],
    );
    here.live.chatLive.show('p1', 'c1');
    await settle();
    vi.mocked(here.api.sendMessage).mockResolvedValueOnce({ status: 'start', pending: [{ ...queued, id: 'm2', words: 'said m2' }], running: true });
    await here.live.chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'said m2', chips: [], spaces: {} });
    await settle();
    const s = wire.last()!;
    s.push({ type: 'data-ask-replied', data: { toolCallId: 'ask-1' } });
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'data-user-message', data: { id: 'm2', words: 'said m2', chips: [], sentAt: '2026-11-12T08:01:00.000Z' } });
    s.push({ type: 'text-delta', id: 't1', delta: 'Both, in order.' });
    await settle();
    expect(here.messages()[1]!.parts[0]).toMatchObject(CLOSED);
    expect(userMessageOrder(here.messages())).toEqual(['u0', 'm1', 'm2']);
  });
});
