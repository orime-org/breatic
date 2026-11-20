// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Comment requests on a Space document's own connection (#1488 §11.9): sent
 * after the provider's send window, so collab applies the edit before it
 * handles the request; answered on the same connection; a mention collab has
 * not confirmed is sent again once the connection is back and synced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { createMentionOutbox, sendCommentRequest } from '@web/data/yjs/comment-requests';

const SPACE = '4d1a0d66-ee82-4596-986a-21054cd65490';
const CONNECTION = '6758483e-75bb-4285-84f1-a375438cfb1a';
const FLUSH = 50;

/** A provider that records what it sends and lets a test raise its events. */
interface FakeProvider {
  provider: HocuspocusProvider;
  sent: Array<Record<string, unknown>>;
  emit: (event: string, data?: unknown) => void;
  answer: (response: Record<string, unknown>) => void;
}

/**
 * A provider stand-in with the parts the module uses.
 * @returns The provider and its controls.
 */
function fakeProvider(): FakeProvider {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const sent: Array<Record<string, unknown>> = [];
  const provider = {
    configuration: { flushDelay: FLUSH },
    sendStateless: vi.fn((payload: string) => {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    }),
    on: (event: string, fn: (data: unknown) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(fn);
    },
    off: (event: string, fn: (data: unknown) => void) => {
      handlers.get(event)?.delete(fn);
    },
  } as unknown as HocuspocusProvider;
  const emit = (event: string, data?: unknown): void => {
    for (const fn of [...(handlers.get(event) ?? [])]) fn(data);
  };
  return { provider, sent, emit, answer: (response) => emit('stateless', { payload: JSON.stringify(response) }) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendCommentRequest', () => {
  it('sends after the provider send window and resolves with the answer carrying its id', async () => {
    const { provider, sent, answer } = fakeProvider();
    const answered = sendCommentRequest(provider, { type: 'comment:hand-over', payload: { spaceId: SPACE, threadId: 't1', connectionId: CONNECTION } });
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toEqual([{ id: expect.any(String), type: 'comment:hand-over', payload: { spaceId: SPACE, threadId: 't1', connectionId: CONNECTION } }]);
    answer({ id: 'someone-else', ok: false, error: { code: 'FORBIDDEN', message: 'x' } });
    answer({ id: sent[0]!.id, ok: true });
    await expect(answered).resolves.toEqual({ id: sent[0]!.id, ok: true });
  });

  it('resolves with a refusal as collab sent it', async () => {
    const { provider, sent, answer } = fakeProvider();
    const answered = sendCommentRequest(provider, { type: 'comment:cancel-hand-over', payload: { spaceId: SPACE, threadId: 't1' } });
    await vi.advanceTimersByTimeAsync(FLUSH);
    answer({ id: sent[0]!.id, ok: false, error: { code: 'FORBIDDEN', message: 'Only the one who handed it over' } });
    await expect(answered).resolves.toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('fails when the connection closes before the answer', async () => {
    const closing = fakeProvider();
    const closed = sendCommentRequest(closing.provider, { type: 'comment:cancel-hand-over', payload: { spaceId: SPACE, threadId: 't1' } });
    const closedOutcome = closed.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(FLUSH);
    closing.emit('close');
    expect(await closedOutcome).toBeInstanceOf(Error);
  });
});

describe('createMentionOutbox', () => {
  it('sends a mention after the send window and forgets it once collab confirms', async () => {
    const { provider, sent, answer, emit } = fakeProvider();
    const outbox = createMentionOutbox(provider);
    outbox.mentioned(SPACE, 'e1');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toEqual([{ id: expect.any(String), type: 'comment:mentioned', payload: { spaceId: SPACE, entryId: 'e1' } }]);
    answer({ id: sent[0]!.id, ok: true });
    emit('synced', { state: true });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(1);
    outbox.dispose();
  });

  it('sends an unconfirmed mention again once the connection is back and synced, until it is confirmed', async () => {
    const { provider, sent, answer, emit } = fakeProvider();
    const outbox = createMentionOutbox(provider);
    outbox.mentioned(SPACE, 'e1');
    await vi.advanceTimersByTimeAsync(FLUSH);
    emit('close');
    emit('synced', { state: true });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent.map((m) => m.payload)).toEqual([
      { spaceId: SPACE, entryId: 'e1' },
      { spaceId: SPACE, entryId: 'e1' },
    ]);
    answer({ id: sent[1]!.id, ok: true });
    emit('synced', { state: true });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(2);
    outbox.dispose();
  });

  it('drops a mention collab refused for good, and sends one it could not take yet again after a while', async () => {
    const { provider, sent, answer } = fakeProvider();
    const outbox = createMentionOutbox(provider, { retryMs: 1000 });
    outbox.mentioned(SPACE, 'gone');
    outbox.mentioned(SPACE, 'busy');
    await vi.advanceTimersByTimeAsync(FLUSH);
    const byEntry = (entryId: string): string => String(sent.find((m) => (m.payload as { entryId: string }).entryId === entryId)!.id);
    answer({ id: byEntry('gone'), ok: false, error: { code: 'NOT_FOUND', message: 'gone' } });
    answer({ id: byEntry('busy'), ok: false, error: { code: 'BUSY', message: 'busy' } });
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1000 + FLUSH);
    expect(sent.map((m) => (m.payload as { entryId: string }).entryId)).toEqual(['busy']);
    outbox.dispose();
  });

  it('stops listening once disposed', async () => {
    const { provider, sent, emit } = fakeProvider();
    const outbox = createMentionOutbox(provider);
    outbox.mentioned(SPACE, 'e1');
    await vi.advanceTimersByTimeAsync(FLUSH);
    outbox.dispose();
    emit('synced', { state: true });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(1);
  });
});
