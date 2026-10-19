// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn the server refuses for its shape is checked against the live build
 * before the panel says anything about it, so an out-of-date page has
 * silenced the panel's toast by the time the turn settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: 60_000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10, currentSpaceMaxChars: 100_000, spaceListMaxItems: 200,
    })),
  },
}));

const order: string[] = [];
const checkStaleRelease = vi.hoisted(() => vi.fn());
vi.mock('@web/data/deployment/stale-release', () => ({ checkStaleRelease }));

const { chatSessionFor, evictAllChatSessions, sendInSession } = await import(
  '@web/stores/chat-sessions'
);
const { watchChatMishaps } = await import('@web/stores/chat-mishaps');

const original = globalThis.fetch;
let stopWatching = (): void => undefined;

/**
 * Answer every request with an error envelope.
 * @param error - The envelope's `error` object.
 */
function refuseWith(error: Record<string, unknown>): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error }), {
        status: Number(error.code),
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
}

beforeEach(() => {
  evictAllChatSessions();
  order.length = 0;
  checkStaleRelease.mockReset().mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push('checked');
    return true;
  });
  stopWatching = watchChatMishaps(() => order.push('told'));
  chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
  });
});

afterEach(() => {
  stopWatching();
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

describe('a refused turn on a page that may be out of date', () => {
  it('checks the build with the mark the server set, before telling the user', async () => {
    refuseWith({ code: 422, message: 'Invalid input', reason: 'request_shape' });
    await sendInSession('c-1', 'hello');
    await vi.waitFor(() => expect(order).toContain('told'));
    expect(checkStaleRelease).toHaveBeenCalledWith('request_shape');
    expect(order).toEqual(['checked', 'told']);
  });

  it('hands a business refusal to the check unmarked', async () => {
    refuseWith({ code: 422, message: 'Message too long' });
    await sendInSession('c-1', 'hello');
    await vi.waitFor(() => expect(order).toContain('told'));
    expect(checkStaleRelease).toHaveBeenCalledWith(undefined);
  });
});
