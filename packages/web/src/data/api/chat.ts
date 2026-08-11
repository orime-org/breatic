// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ConversationEntity, MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES } from '@breatic/shared';

import { sseStream } from '@web/data/stream/sse';
import { apiGet, apiPost } from '@web/data/api/request';

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationDetail {
  id: string;
  name: string;
  messages: MessageData[];
}

/** Everything the panel needs to render, from one call. */
export interface OpenChatResult {
  /** This user's conversations in this project, most recently used first. */
  conversations: ConversationEntity[];
  /** The one to show, and what has been said in it. */
  current: {
    conversation: ConversationEntity;
    messages: MessageData[];
  };
}

/** What the caller says; the field names the server reads are applied here. */
export interface SendMessageInput {
  projectId: string;
  conversationId: string;
  message: string;
}

/** Every event name the contract declares, for checking one off the wire. */
const KNOWN_EVENTS = new Set<string>(Object.values(SSE_EVENT_NAMES));

/**
 * Read one wire frame.
 *
 * A frame that will not parse, or that names an event the contract does not
 * carry, is dropped here rather than passed on: the panel has no rendering
 * for it, and handing it over would leave every consumer to guess.
 * @param data - The raw `data:` payload of one frame
 * @returns The event, or null when there is nothing usable in it
 */
function parseEvent(data: string): SSEEventEnvelope | null {
  try {
    const parsed = JSON.parse(data) as SSEEventEnvelope;
    return KNOWN_EVENTS.has(parsed.event) ? parsed : null;
  } catch {
    return null;
  }
}

export const chatApi = {
  /**
   * Open chat in a project.
   *
   * The one place a conversation is created, and the only call the panel needs
   * to render itself: it answers with this user's conversations here plus the
   * messages of whichever one they used last. A project with no conversation
   * yet gets an empty one made for it.
   * @param projectId - Project to open chat in
   * @returns The conversation list and the current conversation with its messages
   */
  openChat(projectId: string): Promise<OpenChatResult> {
    return apiPost<OpenChatResult, { project_id: string }>('/chat/open', {
      project_id: projectId,
    });
  },
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
   * Stream a reply to one message.
   *
   * Resolves when the stream closes; events arrive through `onEvent` as they
   * come. Cancel with an `AbortController` — the server notices the client
   * leaving and stops the turn rather than running it out for nobody.
   * @param input - Who is speaking, where, and what they said
   * @param handlers - Stream lifecycle callbacks
   * @param handlers.onEvent - Invoked for each event the contract declares
   * @param handlers.onClose - Invoked when the stream closes cleanly
   * @param handlers.onError - Invoked on transport, parse or abort error
   * @param handlers.signal - Abort signal to stop the turn
   * @returns A promise that resolves when the stream closes
   */
  streamMessage(
    input: SendMessageInput,
    handlers: {
      onEvent: (e: SSEEventEnvelope) => void;
      onClose?: () => void;
      onError?: (err: unknown) => void;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    return sseStream<SSEEventEnvelope>({
      url: '/chat/message',
      body: {
        message: input.message,
        project_id: input.projectId,
        conversation_id: input.conversationId,
        // Attaching canvas nodes to a message is PR-5; the server takes these
        // as given and validates them, so they go as empty rather than absent.
        attached_chips: [],
        resource_list: [],
      },
      parseEvent,
      ...handlers,
    });
  },
};
