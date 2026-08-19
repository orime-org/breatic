// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every API request to our own backend is built on one prefix. (Locally
 * stored assets are served outside it and arrive as complete URLs from the
 * storage layer, so they never pass through either transport below.)
 *
 * The two transports reach the same server by different routes — axios for
 * ordinary calls, `fetchEventSource` for the streams — and each used to spell
 * the prefix itself. They drifted: axios said `/api/v1`, the stream wrapper
 * said `/api`, and since the dev proxy forwards `/api/` without rewriting,
 * both streaming endpoints were posting to an address the server does not
 * serve. Neither had ever been used, so nothing complained.
 *
 * A second spelling is the whole of that bug, so the assertions below are
 * about the prefix coming from one place, not about it having the right
 * value in three places.
 *
 * @see packages/server/src/app.ts — the mount point these must match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchEventSourceMock = vi.hoisted(() => vi.fn());
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: fetchEventSourceMock,
}));

import { API_BASE_PATH } from '@web/data/api/base-path';
import { request } from '@web/data/api/request';
import { textToolsApi } from '@web/data/api/text-tools';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';

/**
 * The URL the last stream call was opened against.
 * @returns The first argument `fetchEventSource` received.
 */
function lastStreamUrl(): unknown {
  return fetchEventSourceMock.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  fetchEventSourceMock.mockReset();
  fetchEventSourceMock.mockResolvedValue(undefined);
  evictAllChatSessions();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the API prefix has one definition', () => {
  it('is the version the server mounts its routes under', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('axios sends every ordinary call through it', () => {
    expect(request.defaults.baseURL).toBe(API_BASE_PATH);
  });

  it('the agent chat stream opens under it', async () => {
    // Driven rather than read off the transport: the SDK keeps `api`
    // protected, and what matters is the address a turn actually goes to.
    const fetching = vi.fn(async (_url: string) => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetching);

    await chatSessionFor({
      projectId: 'p1',
      conversationId: 'c1',
      history: [],
      onTitled: () => undefined,
    }).sendMessage({ text: 'hi' });

    const [url] = fetching.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${API_BASE_PATH}/chat/message`);
  });

  it('the text mini-tool stream opens under it', async () => {
    await textToolsApi.stream(
      { toolId: 'polish', document: 'text' },
      { onEvent: () => undefined },
    );
    expect(lastStreamUrl()).toBe(`${API_BASE_PATH}/mini-tools/text`);
  });
});
