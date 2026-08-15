// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the chat client sends, and what it understands coming back.
 *
 * The field names here were wrong in every one of them — `projectId` where
 * the server reads `project_id`, `content` where it reads `message` — and it
 * never showed, because nothing called this. Wiring it up is what makes the
 * names matter, so they are pinned by value rather than by shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSE_EVENT_NAMES } from '@breatic/shared';

const sseStream = vi.fn(async (_opts: Record<string, unknown>) => undefined);
const apiPost = vi.fn(async () => ({ conversations: [], current: null }));

vi.mock('@web/data/stream/sse', () => ({ sseStream }));
vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn(), apiPost }));

const { chatApi } = await import('@web/data/api/chat');

/**
 * The options the client handed to the stream helper on its last call.
 * @returns The stream options, or undefined when it was never called.
 */
function lastStreamCall(): { url: string; body: unknown } | undefined {
  return sseStream.mock.calls.at(-1)?.[0] as unknown as
    | { url: string; body: unknown }
    | undefined;
}

describe('opening chat in a project', () => {
  beforeEach(() => {
    apiPost.mockClear();
    sseStream.mockClear();
  });

  it('posts the project under the name the server reads', async () => {
    await chatApi.openChat('p-1');

    expect(apiPost).toHaveBeenCalledWith(
      '/chat/open',
      { project_id: 'p-1' },
      { signal: undefined },
    );
  });

  it('hands the signal down, so the caller can say it no longer wants this', async () => {
    const abort = new AbortController();
    await chatApi.openChat('p-1', abort.signal);

    // The answer replaces the whole conversation on screen. A caller who has
    // moved on needs it not to arrive, not merely to be ignored on arrival.
    expect(apiPost).toHaveBeenCalledWith(
      '/chat/open',
      { project_id: 'p-1' },
      { signal: abort.signal },
    );
  });
});

describe('sending a message', () => {
  beforeEach(() => {
    sseStream.mockClear();
  });

  it('sends exactly the five fields the server validates', async () => {
    await chatApi.streamMessage(
      { projectId: 'p-1', conversationId: 'c-1', message: 'find me references' },
      { onEvent: () => undefined },
    );

    // Deep equal, not a subset: an extra field is dropped by the server
    // without a word, and a missing one is a 422 the user sees as a failure
    // with no cause.
    expect(lastStreamCall()?.body).toEqual({
      message: 'find me references',
      project_id: 'p-1',
      conversation_id: 'c-1',
      attached_chips: [],
      resource_list: [],
    });
  });

  it('opens the stream at the message endpoint', async () => {
    await chatApi.streamMessage(
      { projectId: 'p-1', conversationId: 'c-1', message: 'hi' },
      { onEvent: () => undefined },
    );

    expect(lastStreamCall()?.url).toBe('/chat/message');
  });
});

describe('reading the stream', () => {
  beforeEach(() => {
    sseStream.mockClear();
  });

  /**
   * Feed one wire frame through the parser the client installed.
   * @param frame - The event as it arrives on the wire
   * @returns Whatever the parser made of it
   */
  async function parse(frame: unknown): Promise<unknown> {
    await chatApi.streamMessage(
      { projectId: 'p-1', conversationId: 'c-1', message: 'hi' },
      { onEvent: () => undefined },
    );
    const parseEvent = (sseStream.mock.calls.at(-1)?.[0] as unknown as {
      parseEvent: (d: string) => unknown;
    }).parseEvent;
    return parseEvent(JSON.stringify(frame));
  }

  it('recognises every event the contract declares', async () => {
    for (const event of Object.values(SSE_EVENT_NAMES)) {
      const parsed = await parse({ event, data: {} });
      expect(parsed, `event ${event} was not recognised`).toMatchObject({ event });
    }
  });

  it('drops a frame it cannot read rather than passing on a broken one', async () => {
    await chatApi.streamMessage(
      { projectId: 'p-1', conversationId: 'c-1', message: 'hi' },
      { onEvent: () => undefined },
    );
    const parseEvent = (sseStream.mock.calls.at(-1)?.[0] as unknown as {
      parseEvent: (d: string) => unknown;
    }).parseEvent;

    expect(parseEvent('not json at all')).toBeNull();
  });

  it('drops a frame whose event name is not in the contract', async () => {
    // A name the contract does not carry is either a server ahead of this
    // client or a bug; either way the panel has no rendering for it, and
    // passing it on would have every consumer guess.
    expect(await parse({ event: 'something_new', data: {} })).toBeNull();
  });
});
