// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the chat client asks for.
 *
 * The field names here were wrong in every one of them — `projectId` where
 * the server reads `project_id` — and it never showed, because nothing called
 * this. Wiring it up is what makes the names matter, so they are pinned by
 * value rather than by shape.
 *
 * 一轮对话本身不再从这里发出去：传输归 `DefaultChatTransport`，请求体的形状
 * 由 `pages/project/chat/__tests__/turn-states.test.tsx` 整份比对。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiPost = vi.fn(async () => ({ conversations: [], current: null }));
const apiGet = vi.fn(async (_url: string, _config?: { params?: object; signal?: AbortSignal }) => ({
  conversations: [],
  hasMore: false,
}));

vi.mock('@web/data/api/request', () => ({ apiGet, apiPost }));

const { chatApi } = await import('@web/data/api/chat');

describe('opening chat in a project', () => {
  beforeEach(() => {
    apiPost.mockClear();
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

describe('asking for a page of the conversation list', () => {
  beforeEach(() => {
    apiGet.mockClear();
  });

  it('names the project the way the server reads it', async () => {
    // The one that got away when the names above were fixed. Spelt
    // `projectId`, zod drops it, the server lists every conversation this
    // user has in any project, and nothing anywhere reports a thing.
    await chatApi.listConversations('p-1');

    expect(apiGet).toHaveBeenCalledWith('/chat/conversations', {
      params: { project_id: 'p-1' },
      signal: undefined,
    });
  });

  it('names both halves of the cursor the way the server reads them', async () => {
    await chatApi.listConversations('p-1', { updatedAt: '2026-08-18T00:00:00Z', id: 'c-9' });

    expect(apiGet).toHaveBeenCalledWith('/chat/conversations', {
      params: {
        project_id: 'p-1',
        before_updated_at: '2026-08-18T00:00:00Z',
        before_id: 'c-9',
      },
      signal: undefined,
    });
  });

  it('asks for the first page without a cursor at all, rather than with an empty one', async () => {
    // Sending the keys with nothing in them is a different question: the
    // server reads a cursor as "the rows before this one", and one that says
    // nothing about where it starts has no rows before it.
    await chatApi.listConversations('p-1');

    const params = apiGet.mock.calls.at(-1)?.[1]?.params ?? {};
    expect(Object.keys(params)).toEqual(['project_id']);
  });

  it('hands the signal down, so leaving the project stops the request', async () => {
    const abort = new AbortController();
    await chatApi.listConversations('p-1', undefined, abort.signal);

    expect(apiGet).toHaveBeenCalledWith('/chat/conversations', {
      params: { project_id: 'p-1' },
      signal: abort.signal,
    });
  });
});
