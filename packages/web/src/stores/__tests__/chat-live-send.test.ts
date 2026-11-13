// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Sending a message (inner#1717). Every message goes to `POST /chat/message`
 * under an id made at the press; the page draws nothing of it until the
 * server answers, and then the box empties and the waiting area takes what the
 * server holds. A send whose outcome is unknown goes again with the same id;
 * one the server refused leaves the words where they were. One page sends one
 * message at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSendAnswer, ChatSyncAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { chatLive, resetChatLiveForTests, useChatLive } from '@web/stores/chat-live';
import { useChatWaiting } from '@web/stores/chat-waiting';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { chatAttachments } from '@web/stores/chat-attachments';
import { watchChatMishaps, type ChatMishap } from '@web/stores/chat-mishaps';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { settle, stubRunWire, type RunWire } from '@web/test-utils/chat-run-wire';

const IDLE: ChatSyncAnswer = { pending: [], running: false, awaiting: false, next_sync_ms: 3000 };

/** An attached item. */
const CHIP = { id: 'chip-1', type: 'text' as const, name: 'notes.txt', data_snapshot: { text: 'n' } };

let wire: RunWire;
let told: ChatMishap[];
let unwatch: () => void;

/**
 * Send the words in the box.
 * @param words - What is typed.
 * @param chips - What is attached.
 * @returns How the send ended.
 */
function send(words = 'make it blue', chips = [CHIP]): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p1', conversationId: 'c1', words, chips, spaces: {} });
}

/**
 * What the server answers for a send.
 * @param status - Its status.
 * @param running - Whether a run holds the conversation.
 * @param pending - The queue.
 * @returns The answer.
 */
function answer(status: ChatSendAnswer['status'], running = true, pending: ChatSendAnswer['pending'] = []): ChatSendAnswer {
  return { status, pending, running };
}

/**
 * A refusal as axios hands it over.
 * @param status - The HTTP status.
 * @param extra - More of it.
 * @returns The exception.
 */
function refused(status: number, extra: Partial<ConstructorParameters<typeof ApiException>[0]> = {}): ApiException {
  return new ApiException({ status, message: `refused ${String(status)}`, fromServer: status !== 0, ...extra });
}

/**
 * The bodies sent, in order.
 * @returns Each body.
 */
function bodies(): Array<Record<string, unknown>> {
  return vi.mocked(chatApi.sendMessage).mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
  wire = stubRunWire();
  vi.spyOn(chatApi, 'streamConfig').mockResolvedValue({
    heartbeatIntervalMs: 1000, attachmentMaxChars: 200_000, attachmentMaxItems: 10, currentSpaceMaxChars: 100_000,
    spaceListMaxItems: 200, spaceReadTimeoutMs: 20_000, runningPollIntervalMs: 5000, syncIntervalMs: 3000,
  });
  vi.spyOn(chatApi, 'readConversation').mockResolvedValue({ conversation: { id: 'c1' } as never, messages: [], hasMore: false });
  vi.spyOn(chatApi, 'sync').mockResolvedValue(IDLE);
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue(answer('queued'));
  vi.spyOn(chatAttachments, 'removeSent');
  told = [];
  unwatch = watchChatMishaps((m) => told.push(m));
  chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [], onTitled: () => {} });
  conversationRuntime.setDraft('c1', 'make it blue');
});

afterEach(() => {
  unwatch();
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a message sent', () => {
  it('goes out under an id made at the press, drawn nowhere but the waiting area once the server holds it (WB-03)', async () => {
    const item = { id: 'from-server', sentAt: '2026-11-12T08:00:00.000Z', words: 'make it blue', chips: [CHIP] };
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce(answer('queued', true, [item]));
    await send();
    const [body] = bodies();
    expect(body).toMatchObject({ message: 'make it blue', project_id: 'p1', conversation_id: 'c1', attached_chips: [CHIP] });
    expect(body!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(chatSessionFor({ projectId: 'p1', conversationId: 'c1', history: [], onTitled: () => {} }).messages).toEqual([]);
    expect(useChatWaiting.getState().byConversation.c1?.pending).toEqual([item]);
  });

  it('empties the box and lets the sent items go once, then reads the history before attaching (WB-04)', async () => {
    const order: string[] = [];
    vi.mocked(chatApi.readConversation).mockImplementation(async () => {
      order.push('read');
      return { conversation: { id: 'c1' } as never, messages: [], hasMore: false };
    });
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce(answer('start'));
    chatLive.show('p1', 'c1');
    await settle();
    // Showing it read the history once; what follows is the send's own.
    order.length = 0;
    await send();
    await settle();
    expect(conversationRuntime.draftOf('c1')).toBe('');
    expect(chatAttachments.removeSent).toHaveBeenCalledTimes(1);
    expect(chatAttachments.removeSent).toHaveBeenCalledWith('c1', [CHIP]);
    expect(order).toEqual(['read']);
    expect(wire.asked()).toBe(1);
  });

  it('attaches when queued behind a run this page does not read, and not a second time when it does (WB-05)', async () => {
    chatLive.show('p1', 'c1');
    await settle();
    await send();
    await settle();
    expect(wire.streams()).toHaveLength(1);
    conversationRuntime.setDraft('c1', 'and this');
    await send('and this', []);
    await settle();
    expect(wire.streams()).toHaveLength(1);
    expect(conversationRuntime.draftOf('c1')).toBe('');
  });

  it('counts a duplicate as sent (WB-06)', async () => {
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce(answer('duplicate', false));
    await send();
    expect(conversationRuntime.draftOf('c1')).toBe('');
  });

  for (const [status, reason] of [[409, 'queue_full'], [402, undefined], [422, undefined]] as const) {
    it(`leaves the words and items in the box and tells the server's sentence when refused ${String(status)} (WB-07, WB-08d, WB-10)`, async () => {
      vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(status, reason === undefined ? {} : { reason }));
      await send();
      await settle();
      expect(vi.mocked(chatApi.sendMessage)).toHaveBeenCalledTimes(1);
      expect(conversationRuntime.draftOf('c1')).toBe('make it blue');
      expect(chatAttachments.removeSent).not.toHaveBeenCalled();
      expect(told).toContainEqual(expect.objectContaining({ kind: 'server', message: `refused ${String(status)}` }));
    });
  }
});

describe('a send whose outcome is unknown', () => {
  it('goes again with the same id within a second, the box read-only meanwhile and emptied once (WB-08)', async () => {
    vi.useFakeTimers();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(0, { network: true, fromServer: false })).mockResolvedValueOnce(answer('duplicate', false));
    const sent = send();
    await vi.advanceTimersByTimeAsync(0);
    expect(useChatLive.getState().sending.c1).toBe(true);
    expect(conversationRuntime.draftOf('c1')).toBe('make it blue');
    await vi.advanceTimersByTimeAsync(1000);
    await sent;
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]!.id).toBe(bodies()[0]!.id);
    expect(conversationRuntime.draftOf('c1')).toBe('');
    expect(chatAttachments.removeSent).toHaveBeenCalledTimes(1);
    expect(useChatLive.getState().sending.c1).toBeUndefined();
  });

  it('waits as long as a 429 says before going again (WB-08b)', async () => {
    vi.useFakeTimers();
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(refused(429, { retryAfterSeconds: 2 })).mockResolvedValueOnce(answer('queued'));
    const sent = send();
    await vi.advanceTimersByTimeAsync(1999);
    expect(bodies()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(bodies()).toHaveLength(2);
  });

  it('gives up after the run-once window, keeping the words and items (WB-08e)', async () => {
    vi.useFakeTimers();
    vi.mocked(chatApi.sendMessage).mockRejectedValue(refused(0, { network: true, fromServer: false }));
    const sent = send();
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    await sent;
    const count = bodies().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bodies()).toHaveLength(count);
    expect(conversationRuntime.draftOf('c1')).toBe('make it blue');
    expect(chatAttachments.removeSent).not.toHaveBeenCalled();
    expect(useChatLive.getState().sending.c1).toBeUndefined();
  });
});

describe('two sends on one page', () => {
  it('go one after the other: the second only once the first was answered (WB-09)', async () => {
    let answerFirst!: (a: ChatSendAnswer) => void;
    vi.mocked(chatApi.sendMessage)
      .mockImplementationOnce(() => new Promise((r) => {
        answerFirst = r;
      }))
      .mockResolvedValueOnce(answer('queued'));
    const first = send('one', []);
    const second = send('two', []);
    await settle();
    expect(bodies().map((b) => b.message)).toEqual(['one']);
    answerFirst(answer('queued'));
    await first;
    await second;
    expect(bodies().map((b) => b.message)).toEqual(['one', 'two']);
  });
});

describe('a message that opens a run', () => {
  it('never shows in the waiting area: it is the run opening (WB-23)', async () => {
    const seen: number[] = [];
    const stop = useChatWaiting.subscribe((s) => seen.push(s.byConversation.c1?.pending.length ?? 0));
    vi.mocked(chatApi.sendMessage).mockResolvedValueOnce(answer('start', true, []));
    chatLive.show('p1', 'c1');
    await send();
    await settle();
    stop();
    expect(seen.every((n) => n === 0)).toBe(true);
  });
});
