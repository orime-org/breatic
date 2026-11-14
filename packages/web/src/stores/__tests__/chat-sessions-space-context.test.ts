// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message carries the user's Spaces, read when they pressed send, in the
 * body the server reads (inner#1413).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatSpaceContext } from '@breatic/shared';
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

/**
 * Send one message to c-1.
 * @param words - What is typed.
 * @param spaces - The Spaces read at the press.
 * @returns How the send ended.
 */
function send(words: string, spaces: ChatSpaceContext): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words, chips: [], spaces });
}

/**
 * The body of the last message sent.
 * @returns That body.
 */
function lastBody(): Record<string, unknown> {
  return vi.mocked(chatApi.sendMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const space = { id: 's1', name: 'Storyboard', kind: 'document' as const };

describe('the Spaces on a message the user sends', () => {
  it('puts the Spaces handed to the send in the body beside the message', async () => {
    await send('summarise this', {
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

  it('sends a list without an open Space when the user turned it off', async () => {
    await send('which Spaces are there?', { spaces: [space], spaces_total: 1 });

    expect(lastBody().spaces).toEqual([space]);
    expect(lastBody()).not.toHaveProperty('current_space');
  });

  it('carries only what this send was handed, not what an earlier one was', async () => {
    await send('first', { spaces: [space], spaces_total: 1, current_space: { ...space, state: 'loading' } });
    await send('second', { spaces: [space], spaces_total: 1 });

    expect(lastBody().message).toBe('second');
    expect(lastBody()).not.toHaveProperty('current_space');
  });
});
