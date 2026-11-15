// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A conversation's state outlives the panel looking at it.
 *
 * Collapsing the agent column, switching to another conversation and back,
 * a component remounting: none of these may lose what is on screen. The
 * `Chat` instance is kept in the module by conversation id and components
 * only subscribe to it, the same shape as `getCanvasUndoManager` in
 * `data/yjs/canvas-space.ts`: cached by the data's key, evicted by an
 * explicit action, never tied to a component unmounting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chatSessionFor,
  evictChatSession,
  evictAllChatSessions,
  prependHistory,
  readRun,
} from '@web/stores/chat-sessions';
import type { StoredUiMessage } from '@web/data/api/chat';
import { setLocale } from '@breatic/shared';

/** A page of history read back, just enough of one. */
const HISTORY: StoredUiMessage[] = [
  {
    id: 'row-1',
    role: 'user',
    parts: [{ type: 'text', text: 'something said before' }],
    metadata: { turnIndex: 1, ts: '2026-08-19T00:00:00Z' },
  },
];

/**
 * The session for a conversation in project p-1.
 * @param conversationId - The conversation.
 * @param history - What the store had for it.
 * @returns Its `Chat`.
 */
function sessionOf(conversationId: string, history: StoredUiMessage[] = []): ReturnType<typeof chatSessionFor> {
  return chatSessionFor({ projectId: 'p-1', conversationId, history, onTitled: () => undefined });
}

describe('the Chat instance of a conversation', () => {
  beforeEach(() => {
    evictAllChatSessions();
  });

  it('is the same one each time it is asked for', () => {
    const first = sessionOf('c-1', HISTORY);
    const again = sessionOf('c-1', HISTORY);

    expect(again).toBe(first);
  });

  it('is a different one for each conversation', () => {
    const one = sessionOf('c-1');
    const other = sessionOf('c-2');

    expect(other).not.toBe(one);
  });

  it('is not touched by history handed over a second time', () => {
    // While a run is read, a remounting panel reads the history again;
    // writing it over the session would wipe the half-sentence growing on
    // screen.
    const chat = sessionOf('c-1');
    chat.messages = [
      {
        id: 'in-flight',
        role: 'assistant',
        parts: [{ type: 'text', text: 'writing' }],
        metadata: { turnIndex: 2, ts: '2026-08-19T00:00:02Z' },
      },
    ];

    const again = sessionOf('c-1', HISTORY);

    expect(again.messages).toHaveLength(1);
    expect(again.messages[0]?.id).toBe('in-flight');
  });

  it('takes an earlier page at its head and leaves the half being written alone', () => {
    // The page "load earlier" read has to show on screen, and the screen reads
    // this instance: written only into the store, it would seed the next new
    // instance and do nothing for this one, so the user's press would show
    // nothing.
    const chat = sessionOf('c-1');
    chat.messages = [
      {
        id: 'in-flight',
        role: 'assistant',
        parts: [{ type: 'text', text: 'writing' }],
        metadata: { turnIndex: 2, ts: '2026-08-19T00:00:02Z' },
      },
    ];

    prependHistory('c-1', HISTORY);

    expect(chat.messages.map((m) => m.id)).toEqual(['row-1', 'in-flight']);
  });

  it('does nothing for a conversation not held here', () => {
    // The page came back after the panel moved on, or the conversation was deleted.
    expect(() => {
      prependHistory('c-gone', HISTORY);
    }).not.toThrow();
  });

  it('is a new one once evicted', () => {
    const before = sessionOf('c-1');
    evictChatSession('c-1');
    const after = sessionOf('c-1', HISTORY);

    expect(after).not.toBe(before);
    expect(after.messages).toHaveLength(1);
  });
});

describe('reading a run carries the interface language', () => {
  beforeEach(() => {
    evictAllChatSessions();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setLocale('en');
  });

  it('sends the one the language switcher picked, not the browser one', async () => {
    // The header only governs text the server writes itself for the user to
    // see. The model's reply is not translated: its language is the model's
    // to judge from the conversation.
    const sent: Array<RequestInit | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(init);
        return new Response(null, { status: 204 });
      }),
    );
    setLocale('ja');
    sessionOf('c-1');

    await readRun('c-1', () => undefined);

    // Read without regard to case: header names are case-insensitive and the
    // SDK lowercases what it is given.
    const headers = new Headers(sent.at(-1)?.headers);
    expect(headers.get('accept-language')).toBe('ja');
  });
});
