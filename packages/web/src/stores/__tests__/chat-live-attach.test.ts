// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How the conversation on screen follows the run that holds it (inner#1717):
 * a sync says a run is going, the page reads the newest page of history and
 * then attaches to the run's stream; when the stream ends, however it ends,
 * the page syncs at once; a run that says the next one is open is followed
 * into it; a stream whose beats stop, or whose connection breaks, is told
 * about once and attached to again; switching away lets go of the stream
 * without stopping the run, and coming back reads it again from its start.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { ConversationRead, StoredUiMessage } from '@web/data/api/chat';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { useChatWaiting } from '@web/stores/chat-waiting';
import { watchChatMishaps, type ChatMishap } from '@web/stores/chat-mishaps';
import { useRunningTurns } from '@web/stores/running-turns';
import { BEAT, replyEnds, replyOpens, settle, stubRunWire, type RunWire, storesWhatIsDrawn } from '@web/test-utils/chat-run-wire';

/** What a sync answers when nothing holds the conversation. */
const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** What a sync answers while a run holds it. */
const RUNNING: ChatSyncAnswer = { ...IDLE, running: true };

/**
 * A stored user message.
 * @param id - Its id.
 * @param turn - Its turn.
 * @param text - What it says.
 * @returns The message.
 */
function userRow(id: string, turn: number, text = `said ${id}`): StoredUiMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }], metadata: { turnIndex: turn } as never };
}

/**
 * The newest page of history the server reads back.
 * @param messages - What it holds.
 * @returns The answer.
 */
function page(messages: StoredUiMessage[]): ConversationRead {
  return { conversation: { id: 'c1' } as never, messages, hasMore: false };
}

let wire: RunWire;
let told: ChatMishap[];
let unwatch: () => void;
const order: string[] = [];

/**
 * The conversation's messages as the page holds them.
 * @returns The messages.
 */
function messages(): StoredUiMessage[] {
  return chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [], onTitled: () => {} }).messages;
}

beforeEach(() => {
  wire = stubRunWire();
  order.length = 0;
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 1000,
    attachmentMaxChars: 200_000,
    attachmentMaxItems: 10,
    currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200,
    spaceReadTimeoutMs: 20_000,
    runningPollIntervalMs: 5000,
    syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockImplementation(async () => {
    order.push('read');
    return page([userRow('m1', 1)]);
  });
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'stop').mockResolvedValue({ stopped: true });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    order.push('stream');
    return realFetch(url, init);
  }));
  told = [];
  unwatch = watchChatMishaps((m) => told.push(m));
  chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [], onTitled: () => {} });
});

afterEach(() => {
  unwatch();
  resetChatLiveForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a sync that says a run holds the conversation', () => {
  it('reads the newest page of history first, then attaches to the run (WB-12)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    expect(order).toEqual(['read', 'stream']);
    wire.last()!.push(BEAT);
    for (const f of replyOpens()) wire.last()!.push(f);
    wire.last()!.push({ type: 'text-delta', id: 't1', delta: 'hello' });
    await settle();
    expect(messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages()[1]!.id).not.toBe('server-named');
  });
});

describe('stopping the run being read', () => {
  it('names the run it reads, then the next one once the stream says it opened', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    wire.last()!.push(BEAT);
    wire.last()!.push({ type: 'data-run', transient: true, data: { runId: 'R1' } });
    for (const f of replyOpens()) wire.last()!.push(f);
    await settle();
    await chatLive.stop('p1', 'c1');
    expect(chatApi.stop).toHaveBeenLastCalledWith('c1', 'p1', 'R1');
    wire.last()!.push({ type: 'data-next-run', transient: true, data: { runId: 'R2' } });
    await settle();
    await chatLive.stop('p1', 'c1');
    expect(chatApi.stop).toHaveBeenLastCalledWith('c1', 'p1', 'R2');
  });
});

describe('stopping a run whose stream has not named it yet', () => {
  it('names no run that a read before has already ended', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    const first = wire.last()!;
    first.push(BEAT);
    first.push({ type: 'data-run', transient: true, data: { runId: 'R1' } });
    for (const f of replyOpens()) first.push(f);
    for (const f of replyEnds()) first.push(f);
    first.close();
    await settle();
    // The page sends again, and the server opens the next run for it.
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValueOnce({ status: 'start', pending: [], running: true });
    await chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'again', chips: [], spaces: {} });
    await settle();
    await chatLive.stop('p1', 'c1');
    expect(chatApi.stop).toHaveBeenLastCalledWith('c1', 'p1', undefined);
  });
});

describe('a message a run took in', () => {
  it('leaves the waiting area and stays in the reply where it was read (WB-22)', async () => {
    const m2 = { id: 'm2', sentAt: '2026-11-12T08:00:00.000Z', words: 'blue', chips: [] };
    vi.mocked(chatApi.sync).mockResolvedValueOnce({ ...RUNNING, pending: [m2] });
    chatLive.show('p1', 'c1');
    await settle();
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([m2]);
    for (const f of replyOpens()) wire.last()!.push(f);
    wire.last()!.push({ type: 'data-user-message', data: { id: 'm2', words: 'blue', chips: [], sentAt: '2026-11-12T08:00:00.000Z' } });
    await settle();
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([]);
    expect(messages().at(-1)!.parts.some((p) => p.type === 'data-user-message')).toBe(true);
  });
});

describe('the end of a run being read', () => {
  for (const ending of ['finish', 'interrupted', 'failed', 'awaiting', 'beats only'] as const) {
    it(`syncs at once whatever the run ended with: ${ending} (WB-44, WB-45)`, async () => {
      vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
      chatLive.show('p1', 'c1');
      await settle();
      const s = wire.last()!;
      s.push(BEAT);
      if (ending !== 'beats only') for (const f of replyOpens()) s.push(f);
      await settle();
      const before = vi.mocked(chatApi.sync).mock.calls.length;
      if (ending === 'finish') for (const f of replyEnds()) s.push(f);
      if (ending === 'interrupted') s.push({ type: 'data-interrupted', data: {} });
      if (ending === 'failed') {
        s.push({ type: 'data-failed', data: {} });
        s.push({ type: 'error', errorText: 'The assistant could not finish this turn.' });
      }
      if (ending === 'awaiting') s.push({ type: 'data-ask-awaiting', data: { toolCallId: 'ask-1' } });
      s.close();
      await settle();
      expect(vi.mocked(chatApi.sync).mock.calls.length).toBe(before + 1);
    });
  }

  for (const last of ['read to its end', 'gone before its stream was asked for'] as const) {
    it(`attaches to a run a send opened while the history after the last one was read, with no sync to say so: ${last}`, async () => {
      vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
      let landAfter!: (read: ConversationRead) => void;
      if (last === 'read to its end') {
        chatLive.show('p1', 'c1');
        await settle();
        const s = wire.last()!;
        for (const f of replyOpens()) s.push(f);
        for (const f of replyEnds()) s.push(f);
        vi.mocked(chatApi.readConversation).mockImplementationOnce(() => new Promise((r) => {
          landAfter = r;
        }));
        s.close();
      } else {
        wire.noRunNext();
        vi.mocked(chatApi.readConversation)
          .mockResolvedValueOnce(page([userRow('m1', 1)]))
          .mockImplementationOnce(() => new Promise((r) => {
            landAfter = r;
          }));
        chatLive.show('p1', 'c1');
      }
      await settle();
      // The history read after the run is on its way; a send opens the next run.
      const streamsBefore = wire.streams().length;
      vi.spyOn(chatApi, 'sendMessage').mockResolvedValueOnce({ status: 'start', pending: [], running: true });
      await chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'again', chips: [], spaces: {} });
      await settle();
      landAfter(page([userRow('m1', 1)]));
      await settle();
      expect(wire.streams()).toHaveLength(streamsBefore + 1);
    });
  }

  it('attaches again when the sync after it says a run holds the conversation, and not otherwise (WB-44)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
    chatLive.show('p1', 'c1');
    await settle();
    wire.last()!.push(BEAT);
    wire.last()!.close();
    await settle();
    expect(wire.streams()).toHaveLength(2);
    wire.last()!.push(BEAT);
    wire.last()!.close();
    await settle();
    expect(wire.streams()).toHaveLength(2);
  });

  it('follows a run that says the next one is open into it, reading the history again first (WB-24, WB-30)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'data-failed', data: {} });
    s.push({ type: 'data-next-run', transient: true, data: { runId: 'R2' } });
    s.push({ type: 'error', errorText: 'x' });
    s.close();
    await settle();
    expect(order).toEqual(['read', 'stream', 'read', 'stream']);
  });

  for (const said of ['data-failed then an error frame', 'an error frame alone'] as const) {
    it(`marks a failure only where the server said the run failed: ${said} (WB-28, WB-29)`, async () => {
      vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
      chatLive.show('p1', 'c1');
      await settle();
      const s = wire.last()!;
      for (const f of replyOpens()) s.push(f);
      if (said === 'data-failed then an error frame') s.push({ type: 'data-failed', data: {} });
      await settle();
      storesWhatIsDrawn(messages);
      s.push({ type: 'error', errorText: 'x' });
      s.close();
      await settle();
      expect(messages().at(-1)!.parts.filter((p) => p.type === 'data-failed')).toHaveLength(said === 'an error frame alone' ? 0 : 1);
    });
  }
});

describe('a run whose beats stop', () => {
  it('is told about once as a network problem, read again and attached to again, with no stop mark (WB-25)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
    chatLive.show('p1', 'c1');
    await vi.advanceTimersByTimeAsync(10);
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3 * 1000 + 50);
    expect(told.filter((m) => m.kind === 'network')).toHaveLength(1);
    expect(order.filter((o) => o === 'read')).toHaveLength(2);
    expect(wire.streams()).toHaveLength(2);
    expect(messages().some((m) => m.parts.some((p) => p.type === 'data-interrupted'))).toBe(false);
    expect(chatApi.stop).not.toHaveBeenCalled();
  });
});

describe('a connection that breaks while a run is read', () => {
  it('is told about, read again and attached to again, with what was drawn not drawn twice (WB-42)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
    chatLive.show('p1', 'c1');
    await settle();
    let s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'text-delta', id: 't1', delta: 'part one' });
    await settle();
    s.breakOff();
    await settle();
    expect(told.filter((m) => m.kind === 'network')).toHaveLength(1);
    s = wire.last()!;
    expect(wire.streams()).toHaveLength(2);
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'text-delta', id: 't1', delta: 'part one' });
    await settle();
    expect(messages().filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});

describe('switching conversations', () => {
  it('lets go of the stream without stopping the run, drawing no stop mark and syncing no more (WB-35)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
    chatLive.show('p1', 'c1');
    await vi.advanceTimersByTimeAsync(10);
    for (const f of replyOpens()) wire.last()!.push(f);
    await vi.advanceTimersByTimeAsync(10);
    chatLive.hide('c1');
    await vi.advanceTimersByTimeAsync(10);
    expect(wire.last()!.abandoned()).toBe(true);
    expect(chatApi.stop).not.toHaveBeenCalled();
    expect(messages().some((m) => m.parts.some((p) => p.type === 'data-interrupted'))).toBe(false);
    const syncs = vi.mocked(chatApi.sync).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(chatApi.sync).mock.calls.length).toBe(syncs);
  });

  it('syncs at once on coming back, reads the history again and attaches, the replay drawn once (WB-36)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValue(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    for (const f of replyOpens()) wire.last()!.push(f);
    wire.last()!.push({ type: 'text-delta', id: 't1', delta: 'so far' });
    await settle();
    chatLive.hide('c1');
    await settle();
    const syncs = vi.mocked(chatApi.sync).mock.calls.length;
    chatLive.show('p1', 'c1');
    await settle();
    expect(vi.mocked(chatApi.sync).mock.calls.length).toBe(syncs + 1);
    for (const f of replyOpens()) wire.last()!.push(f);
    wire.last()!.push({ type: 'text-delta', id: 't1', delta: 'so far' });
    await settle();
    expect(messages().filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(order.filter((o) => o === 'read')).toHaveLength(2);
  });

  it('holds at most one stream, the one of the conversation on screen (WB-37)', async () => {
    chatSessionFor({ projectId: 'p1', conversationId: 'c2', history: [], onTitled: () => {} });
    vi.mocked(chatApi.sync).mockResolvedValue(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    chatLive.hide('c1');
    chatLive.show('p1', 'c2');
    await settle();
    const open = wire.streams().filter((s) => !s.abandoned());
    expect(open.map((s) => s.conversationId)).toEqual(['c2']);
  });
});

describe('the running mark of the conversation this page reads', () => {
  it('is set while the run is read, and cleared when it ends or the page lets go of it (WB-38)', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING).mockResolvedValue(IDLE);
    chatLive.show('p1', 'c1');
    await settle();
    wire.last()!.push(BEAT);
    await settle();
    expect(useRunningTurns.getState().byConversation.c1).toBe(true);
    wire.last()!.close();
    await settle();
    expect(wire.streams()).toHaveLength(2);
    expect(useRunningTurns.getState().byConversation.c1).toBe(true);
    chatLive.hide('c1');
    await settle();
    expect(useRunningTurns.getState().byConversation.c1).toBeUndefined();
  });
});

describe('the sync of the conversation on screen', () => {
  it('runs at once, then at each interval, pauses while the tab is hidden, and stops when another is shown (WB-11)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    chatSessionFor({ projectId: 'p1', conversationId: 'c2', history: [], onTitled: () => {} });
    const calls = (): string[] => vi.mocked(chatApi.sync).mock.calls.map((c) => c[0]);
    chatLive.show('p1', 'c1');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toEqual(['c1']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls()).toEqual(['c1', 'c1']);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls()).toEqual(['c1', 'c1']);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toEqual(['c1', 'c1', 'c1']);
    chatLive.hide('c1');
    chatLive.show('p1', 'c2');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toEqual(['c1', 'c1', 'c1', 'c2']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls().filter((c) => c === 'c1')).toHaveLength(3);
    chatLive.hide('c2');
    await vi.advanceTimersByTimeAsync(9000);
    expect(calls()).toHaveLength(5);
  });

  it('puts what the server holds in the waiting area, and why it waits (WB-13, WB-14, WB-15)', async () => {
    const m1 = { id: 'm1', sentAt: '2026-11-12T08:00:00.000Z', words: 'one', chips: [] };
    vi.mocked(chatApi.sync).mockResolvedValueOnce({ ...IDLE, pending: [m1], blocked: 'credits' });
    chatLive.show('p1', 'c1');
    await settle();
    expect(useChatWaiting.getState().byConversation.c1).toMatchObject({ pending: [m1], blocked: true, awaiting: false });
  });
});

describe('the history on screen when no run is read', () => {
  /** A reply the server finished storing. */
  const DONE: StoredUiMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'all done' }],
    metadata: { turnIndex: 1 } as never,
  };

  it('is read again at the next sync when the read on showing does not land', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(chatApi.readConversation)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(page([userRow('m1', 1), DONE]));
    chatLive.show('p1', 'c1');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(3_100);
    expect(messages().map((m) => m.id)).toEqual(['m1', 'a1']);
  });

  it('keeps the page read last when an earlier read lands after it', async () => {
    let landFirst!: (read: ConversationRead) => void;
    vi.mocked(chatApi.readConversation)
      .mockImplementationOnce(() => new Promise((r) => {
        landFirst = r;
      }))
      .mockResolvedValue(page([userRow('m1', 1), DONE, userRow('m2', 2)]));
    chatLive.show('p1', 'c1');
    await settle();
    // The page sends; the server opens a run and its history now holds the message.
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValueOnce({ status: 'start', pending: [], running: true });
    await chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'again', chips: [], spaces: {} });
    await settle();
    landFirst(page([userRow('m1', 1)]));
    await settle();
    expect(messages().map((m) => m.id).slice(0, 3)).toEqual(['m1', 'a1', 'm2']);
  });

  it('is not laid over a run this page has started reading, whose end reads it again', async () => {
    let answerSync!: (seen: ChatSyncAnswer) => void;
    vi.mocked(chatApi.sync).mockImplementationOnce(() => new Promise((r) => {
      answerSync = r;
    }));
    chatLive.show('p1', 'c1');
    await settle();
    // Sent before the sync on showing answers; the server opens a run.
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValueOnce({ status: 'start', pending: [], running: true });
    vi.mocked(chatApi.readConversation).mockResolvedValue(page([userRow('m1', 1), DONE, userRow('m2', 2)]));
    await chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'again', chips: [], spaces: {} });
    await settle();
    const s = wire.last()!;
    s.push(BEAT);
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'text-delta', id: 't1', delta: 'half way' });
    await settle();
    // The sync read the state from before the send.
    answerSync(IDLE);
    await settle();
    expect(messages().at(-1)!.parts).toContainEqual(expect.objectContaining({ type: 'text', text: 'half way' }));
  });

  it('is laid before the run a send opened, the sync on showing answering in between', async () => {
    let answerSync!: (seen: ChatSyncAnswer) => void;
    vi.mocked(chatApi.sync).mockImplementationOnce(() => new Promise((r) => {
      answerSync = r;
    }));
    chatLive.show('p1', 'c1');
    await settle();
    const lands: Array<(read: ConversationRead) => void> = [];
    vi.mocked(chatApi.readConversation).mockImplementation(() => new Promise((r) => {
      lands.push(r);
    }));
    vi.spyOn(chatApi, 'sendMessage').mockResolvedValueOnce({ status: 'start', pending: [], running: true });
    await chatLive.send({ projectId: 'p1', conversationId: 'c1', words: 'again', chips: [], spaces: {} });
    await settle();
    // The sync read the state from before the send.
    answerSync(IDLE);
    await settle();
    lands.shift()!(page([userRow('m1', 1)]));
    await settle();
    const s = wire.last()!;
    s.push(BEAT);
    for (const f of replyOpens()) s.push(f);
    await settle();
    for (const land of lands.splice(0)) land(page([userRow('m1', 1)]));
    await settle();
    expect(messages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('is read again once a run read to its end is over', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    vi.mocked(chatApi.readConversation)
      .mockResolvedValueOnce(page([userRow('m1', 1)]))
      .mockResolvedValue(page([userRow('m1', 1), DONE, userRow('m2', 2), { ...DONE, id: 'a2', metadata: { turnIndex: 2 } as never }]));
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    for (const f of replyEnds()) s.push(f);
    s.close();
    await settle();
    expect(messages().map((m) => m.id)).toEqual(['m1', 'a1', 'm2', 'a2']);
  });

  it('keeps a reply read back after its run under the id it was drawn with, so it is not drawn anew', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    vi.mocked(chatApi.readConversation).mockResolvedValueOnce(page([userRow('m1', 1)]));
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens()) s.push(f);
    s.push({ type: 'text-delta', id: 't1', delta: 'all done' });
    await settle();
    const drawnAs = messages()[1]!.id;
    // The server stores it under the name its stream's `start` gave it.
    vi.mocked(chatApi.readConversation).mockResolvedValue(page([userRow('m1', 1), { ...DONE, id: 'server-named' }]));
    for (const f of replyEnds()) s.push(f);
    s.close();
    await settle();
    expect(chatApi.readConversation).toHaveBeenCalledTimes(2);
    expect(messages().map((m) => m.id)).toEqual(['m1', drawnAs]);
  });

  it('is read again on showing a conversation whose run ended while it was away', async () => {
    vi.mocked(chatApi.readConversation).mockResolvedValue(page([userRow('m1', 1), DONE]));
    chatLive.show('p1', 'c1');
    await settle();
    expect(messages().map((m) => m.id)).toEqual(['m1', 'a1']);
  });

  it('is read again when the run a sync named ended before its stream was asked for', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    vi.mocked(chatApi.readConversation)
      .mockResolvedValueOnce(page([userRow('m1', 1)]))
      .mockResolvedValue(page([userRow('m1', 1), DONE]));
    wire.noRunNext();
    chatLive.show('p1', 'c1');
    await settle();
    expect(messages().map((m) => m.id)).toEqual(['m1', 'a1']);
  });
});

describe('a sync that says a run holds it when no stream is there to read', () => {
  it('leaves the next ask to the sync at its interval', async () => {
    vi.mocked(chatApi.sync).mockResolvedValue(RUNNING);
    wire.noRunNext();
    wire.noRunNext();
    chatLive.show('p1', 'c1');
    await settle(20);
    expect(vi.mocked(chatApi.sync).mock.calls).toHaveLength(1);
    expect(order.filter((o) => o === 'stream')).toHaveLength(1);
  });
});

describe('a run resumed after a card', () => {
  /** The reply paused at a card the user answered, as the history holds it. */
  const PAUSED: StoredUiMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Which ratio?' }],
    metadata: { turnIndex: 1 } as never,
  };

  beforeEach(() => {
    vi.mocked(chatApi.readConversation).mockResolvedValue(page([userRow('m1', 1), PAUSED]));
  });

  it('is drawn as a reply of its own after the reply that asked, as the server stores it', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    for (const f of replyOpens('t2')) s.push(f);
    s.push({ type: 'text-delta', id: 't2', delta: 'Going with 9:16.' });
    for (const f of replyEnds('t2')) s.push(f);
    await settle();
    storesWhatIsDrawn(messages);
    s.close();
    await settle();
    expect(messages().map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages()[1]).toEqual(PAUSED);
    expect(messages()[2]!.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)).toEqual(['Going with 9:16.']);
  });

  it('read back after a stream that drew nothing, keeps the reply under the server name, not the one that asked', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    chatLive.show('p1', 'c1');
    await settle();
    const s = wire.last()!;
    s.push(BEAT);
    s.push({ type: 'start', messageId: 'server-named' });
    await settle();
    const stored: StoredUiMessage = { id: 'server-named', role: 'assistant', parts: [{ type: 'text', text: 'Going with 9:16.' }], metadata: { turnIndex: 1 } as never };
    vi.mocked(chatApi.readConversation).mockResolvedValue(page([userRow('m1', 1), PAUSED, stored]));
    s.close();
    await settle();
    expect(messages().map((m) => m.id)).toEqual(['m1', 'a1', 'server-named']);
  });

  it('leaves the history as it is when no run is there to read', async () => {
    vi.mocked(chatApi.sync).mockResolvedValueOnce(RUNNING);
    wire.noRunNext();
    chatLive.show('p1', 'c1');
    await settle();
    expect(messages()).toEqual([userRow('m1', 1), PAUSED]);
    expect(useRunningTurns.getState().byConversation.c1).toBeUndefined();
    expect(told.filter((m) => m.kind === 'turn')).toEqual([]);
  });
});
