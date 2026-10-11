// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A message carries the reader's Spaces, read when they pressed send, in the
 * body the server reads (inner#1413).
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

const space = { id: 's1', name: 'Storyboard', kind: 'document' as const };

/** Open the conversation the sends below go to. */
function openConversation(): void {
  chatSessionFor({
    projectId: 'p-1',
    conversationId: 'c-1',
    history: [],
    onTitled: () => undefined,
    onFirstFrame: () => undefined,
  });
}

describe('the Spaces on a message the reader sends', () => {
  it('puts the Spaces handed to the send in the body beside the message', async () => {
    openConversation();

    await sendInSession('c-1', 'summarise this', [], {
      spaces: [space],
      spaces_total: 1,
      current_space: { ...space, state: 'loaded', content: '# Scene 1', total_chars: 9 },
    });

    expect(lastBody()).toMatchObject({
      message: 'summarise this',
      project_id: 'p-1',
      conversation_id: 'c-1',
      spaces: [space],
      spaces_total: 1,
      current_space: { id: 's1', state: 'loaded', content: '# Scene 1', total_chars: 9 },
    });
  });

  it('sends a list without an open Space when the reader turned it off', async () => {
    openConversation();

    await sendInSession('c-1', 'which Spaces are there?', [], { spaces: [space], spaces_total: 1 });

    expect(lastBody().spaces).toEqual([space]);
    expect(lastBody()).not.toHaveProperty('current_space');
  });

  it('carries only what this send was handed, not what an earlier one was', async () => {
    openConversation();

    await sendInSession('c-1', 'first', [], {
      spaces: [space],
      spaces_total: 1,
      current_space: { ...space, state: 'loading' },
    });
    await sendInSession('c-1', 'second', [], { spaces: [space], spaces_total: 1 });

    expect(lastBody().message).toBe('second');
    expect(lastBody()).not.toHaveProperty('current_space');
  });
});
