// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every message carries the model of its conversation (#1363). The chat
 * panel reads it at the press (`use-chat-session.ts`) and hands it to the
 * send, which puts it in the body. A send the server refuses is counted, so
 * the picker asks for the list of models again: a page that predates a model
 * being taken off is told so by the refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/data/upload/transfer-body', () => ({
  bodyOrTransfer: async (_projectId: string, body: unknown) => body,
}));

import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import { chatLive, resetChatLiveForTests } from '@web/stores/chat-live';
import { chatSessionFor, evictAllChatSessions } from '@web/stores/chat-sessions';
import { useConversationRuntime } from '@web/stores/conversation-runtime';
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
 * Send "hello" to c-1.
 * @param model - The model handed to the send.
 * @returns How the send ended.
 */
function send(model?: string): ReturnType<typeof chatLive.send> {
  return chatLive.send({ projectId: 'p-1', conversationId: 'c-1', words: 'hello', chips: [], spaces: {}, ...(model === undefined ? {} : { model }) });
}

/**
 * The body of the last message sent.
 * @returns That body.
 */
function lastBody(): Record<string, unknown> {
  return vi.mocked(chatApi.sendMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('the model on a message', () => {
  it('sends the model the send was handed', async () => {
    await send('anthropic/claude-sonnet-5.5');

    expect(lastBody()).toMatchObject({ model: 'anthropic/claude-sonnet-5.5' });
  });

  it('names no model when the conversation has none yet', async () => {
    await send();

    expect(lastBody()).not.toHaveProperty('model');
  });

  it('counts a send the server refused', async () => {
    vi.mocked(chatApi.sendMessage).mockRejectedValueOnce(
      new ApiException({ status: 422, message: 'The selected model is no longer available.', fromServer: true }),
    );
    const before = useConversationRuntime.getState().modelListAsks;

    await send('anthropic/claude-opus-5.5');

    expect(useConversationRuntime.getState().modelListAsks).toBe(before + 1);
  });
});
