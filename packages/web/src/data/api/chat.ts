// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { SSEEventEnvelope } from '@breatic/shared';

import { sseStream } from '@web/data/stream/sse';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { apiGet } from '@web/data/api/request';

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail {
  id: string;
  name: string;
  messages: ChatMessage[];
}

export const chatApi = {
  listConversations(projectId: string) {
    return apiGet<{ conversations: ConversationSummary[] }>(
      '/chat/conversations',
      { params: { projectId } },
    );
  },
  getConversation(id: string) {
    return apiGet<ConversationDetail>(`/chat/conversations/${id}`);
  },
  /**
   * Stream a new agent message. Returns a promise that resolves when the
   * stream closes; events are pushed via `onEvent` as they arrive.
   *
   * Use an `AbortController` (`signal`) to let the user click Abort.
   * @param body - The message request payload.
   * @param body.projectId - Project the conversation belongs to.
   * @param body.conversationId - Conversation to append to. The server requires
   *   one and refuses a request without it: `POST /chat/open` is the only place
   *   a conversation is created, so a client always has an id before it can
   *   speak. This call still sends the wrong field names — the server reads
   *   `conversation_id` and `message` — so it cannot succeed yet; wiring it up
   *   is PR-3 batch 6. It does at least reach the right address now.
   * @param body.content - The user's message text.
   * @param body.references - Canvas entities (nodes / spaces) attached as context.
   * @param handlers - Stream lifecycle callbacks.
   * @param handlers.onEvent - Invoked for each parsed agent stream event.
   * @param handlers.onClose - Invoked when the stream closes cleanly.
   * @param handlers.onError - Invoked on transport / parse / abort error.
   * @param handlers.signal - Abort signal to cancel the stream on user request.
   * @returns A promise that resolves when the SSE stream closes.
   */
  streamMessage(
    body: {
      projectId: string;
      conversationId?: string;
      content: string;
      references?: Array<{ kind: string; id: string }>;
    },
    handlers: {
      onEvent: (e: SSEEventEnvelope) => void;
      onClose?: () => void;
      onError?: (err: unknown) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    return sseStream<SSEEventEnvelope>({
      url: '/chat/message',
      body,
      parseEvent: (data) => {
        try {
          return JSON.parse(data) as SSEEventEnvelope;
        } catch {
          return null;
        }
      },
      ...handlers,
    });
  },
};
