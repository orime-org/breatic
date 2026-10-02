// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every message carries the time zone the reader's browser reports, so the
 * agent can say what time it is where they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/api/chat', () => ({
  chatApi: {
    streamConfig: vi.fn(async () => ({
      heartbeatIntervalMs: 60_000,
      attachmentMaxChars: 200_000,
      attachmentMaxItems: 10,
    })),
  },
}));

const { chatSessionFor, evictAllChatSessions, sendInSession } = await import(
  '@web/stores/chat-sessions'
);

/** A stream that opens a turn and ends it. */
const OPENS_AND_ENDS =
  'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';

let sent: Array<RequestInit | undefined> = [];
const original = globalThis.fetch;

beforeEach(() => {
  evictAllChatSessions();
  sent = [];
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    sent.push(init);
    return Promise.resolve(
      new Response(OPENS_AND_ENDS, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/**
 * The body of the last request sent.
 * @returns That body, parsed.
 */
function lastBody(): Record<string, unknown> {
  return JSON.parse(String(sent.at(-1)?.body)) as Record<string, unknown>;
}

describe('the time zone on a message', () => {
  it('sends the zone the browser reports', async () => {
    const actual = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...actual.call(this), timeZone: 'Asia/Shanghai' };
    });
    chatSessionFor({
      projectId: 'p-1',
      conversationId: 'c-1',
      history: [],
      onTitled: () => undefined,
      onFirstFrame: () => undefined,
    });

    await sendInSession('c-1', 'what time is it?');

    expect(lastBody().time_zone).toBe('Asia/Shanghai');
  });
});
