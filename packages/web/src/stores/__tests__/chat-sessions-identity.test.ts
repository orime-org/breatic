// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A chat message to a region goes out only once the identity token is fresh
 * (inner#1955): a tab that sat hidden past the token's minute would otherwise
 * send it with an expired token and have it refused.
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
const order = vi.hoisted(() => [] as string[]);
vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: vi.fn(async (_projectId: string, body: unknown) => {
    order.push('upload');
    return body;
  }),
}));
let freshen: () => void = () => undefined;
const ensureFreshIdentity = vi.hoisted(() => vi.fn());
vi.mock('@web/data/api/identity-renewal', () => ({ ensureFreshIdentity }));

const { chatSessionFor, evictAllChatSessions, sendInSession } = await import('@web/stores/chat-sessions');

const OPENS_AND_ENDS = 'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';
let sent = 0;
const original = globalThis.fetch;

beforeEach(() => {
  evictAllChatSessions();
  sent = 0;
  order.length = 0;
  ensureFreshIdentity.mockImplementation(() => new Promise<void>((resolve) => {
    order.push('fresh');
    freshen = resolve;
  }));
  globalThis.fetch = (() => {
    sent += 1;
    return Promise.resolve(new Response(OPENS_AND_ENDS, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

describe('the identity token on a chat message', () => {
  it('sends the message only after the token is fresh', async () => {
    chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });

    const sending = sendInSession('c-1', 'hello');
    await vi.waitFor(() => expect(ensureFreshIdentity).toHaveBeenCalled());
    expect(sent).toBe(0);
    freshen();
    await sending;
    expect(sent).toBe(1);
  });

  // An oversized body goes up through storage first, which can outlast the
  // token; the check comes right before the message leaves.
  it('checks the token after the body is uploaded', async () => {
    chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined, onFirstFrame: () => undefined });

    const sending = sendInSession('c-1', 'hello');
    await vi.waitFor(() => expect(ensureFreshIdentity).toHaveBeenCalled());
    freshen();
    await sending;
    expect(order).toEqual(['upload', 'fresh']);
  });
});
