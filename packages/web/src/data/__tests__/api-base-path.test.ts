// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every request to our own backend is built on one prefix.
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
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchEventSourceMock = vi.hoisted(() => vi.fn());
vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: fetchEventSourceMock,
}));

import { API_BASE_PATH } from '@web/data/api/base-path';
import { request } from '@web/data/api/request';
import { chatApi } from '@web/data/api/chat';
import { textToolsApi } from '@web/data/api/text-tools';

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
});

describe('the API prefix has one definition', () => {
  it('is the version the server mounts its routes under', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
  });

  it('axios sends every ordinary call through it', () => {
    expect(request.defaults.baseURL).toBe(API_BASE_PATH);
  });

  it('the agent chat stream opens under it', async () => {
    await chatApi.streamMessage(
      { projectId: 'p1', content: 'hi' },
      { onEvent: () => undefined },
    );
    expect(lastStreamUrl()).toBe(`${API_BASE_PATH}/chat/message`);
  });

  it('the text mini-tool stream opens under it', async () => {
    await textToolsApi.stream(
      { toolId: 'polish', document: 'text' },
      { onEvent: () => undefined },
    );
    expect(lastStreamUrl()).toBe(`${API_BASE_PATH}/mini-tools/text`);
  });
});
