// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every message carries the time zone the user's browser reports, so the
 * agent can say what time it is where they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import { chatApi } from '@web/data/api/chat';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

beforeEach(() => {
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'queued', pending: [], running: false });
  chatSessionFor({ projectId: 'p-1', conversationId: 'c-1', history: [], onTitled: () => undefined });
});

afterEach(() => {
  resetChatLiveForTests();
  resetRunOnceForTests();
  evictAllChatSessions();
  vi.restoreAllMocks();
});

describe('the time zone on a message', () => {
  it('sends the zone the browser reports', async () => {
    const actual = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...actual.call(this), timeZone: 'Asia/Shanghai' };
    });

    await chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'what time is it?', chips: [], spaces: {} });

    const body = vi.mocked(chatApi.sendMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(body.time_zone).toBe('Asia/Shanghai');
  });
});
