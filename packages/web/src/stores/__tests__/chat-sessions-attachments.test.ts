// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A message that carries attached items (inner#1717).
 *
 * The items go in the request beside the words. Once the server holds the
 * message, the items it carried leave the list above the box; the page draws
 * the message itself only from what the server answers (the waiting area) or
 * from the history.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import type { ChatAttachedChip } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import { chatAttachments } from '@web/stores/chat-attachments';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

const image: ChatAttachedChip = {
  id: 'a1',
  type: 'image',
  name: 'cover.png',
  data_snapshot: { url: 'https://cdn.example/cover.png' },
};

beforeEach(() => {
  vi.spyOn(chatApi, 'sendMessage').mockResolvedValue({ status: 'queued', pending: [], running: false });
  vi.spyOn(chatAttachments, 'removeSent');
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
 * @param chips - What is attached.
 * @returns How the send ended.
 */
function send(words: string, chips: readonly ChatAttachedChip[]): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words, chips, spaces: {} });
}

/**
 * The body of the last message sent.
 * @returns That body.
 */
function lastBody(): Record<string, unknown> {
  return vi.mocked(chatApi.sendMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('a message carrying attachments', () => {
  it('sends them in the request beside the words', async () => {
    await send('what is in this?', [image]);

    expect(lastBody().message).toBe('what is in this?');
    expect(lastBody().attached_chips).toEqual([image]);
  });

  it('lets go of what it carried, once, when the server holds the message', async () => {
    await send('what is in this?', [image]);

    expect(chatAttachments.removeSent).toHaveBeenCalledTimes(1);
    expect(chatAttachments.removeSent).toHaveBeenCalledWith('c-1', [image]);
  });

  it('sends an empty list when nothing is attached', async () => {
    await send('hello', []);

    expect(lastBody().attached_chips).toEqual([]);
  });
});
