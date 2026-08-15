// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ConversationEntity, MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES } from '@breatic/shared';

import { sseStream } from '@web/data/stream/sse';
import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';

export interface ConversationSummary {
  id: string;
  name: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * A conversation as it arrives here, which is not quite as the server holds it.
 *
 * `ConversationEntity` types its three timestamps as `Date`, and that is true
 * of the row. It is not true of anything that has been through JSON: what
 * lands here is the string the date was serialised to. Declaring that is the
 * job of this layer -- the alternative is every reader downstream believing it
 * has a Date and finding out otherwise only when it calls a method on one.
 */
export type ConversationOnTheWire = Omit<
  ConversationEntity,
  'createdAt' | 'updatedAt' | 'deletedAt'
> & {
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

/** One conversation with the newest page of what was said in it. */
export interface ConversationRead {
  conversation: ConversationOnTheWire;
  messages: MessageData[];
  /** The conversation reaches back further than these messages do. */
  hasMore: boolean;
}

/** One page of a conversation, and whether anything is older. */
export interface MessagePage {
  /** The messages, oldest first. */
  messages: MessageData[];
  /** There are older messages than these. */
  hasMore: boolean;
}

/** Everything the panel needs to render, from one call. */
export interface OpenChatResult {
  /** This user's conversations in this project, most recently used first. */
  conversations: ConversationOnTheWire[];
  /** The one to show, and what has been said in it. */
  current: {
    conversation: ConversationOnTheWire;
    messages: MessageData[];
    /** The conversation reaches back further than these messages do. */
    hasMore: boolean;
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
   * @param signal - Raised when nobody is waiting for this answer any more.
   *   The answer replaces what is on screen, so one belonging to a visit the
   *   reader has already left must not arrive at all.
   * @returns The conversation list and the current conversation with its messages
   */
  openChat(projectId: string, signal?: AbortSignal): Promise<OpenChatResult> {
    return apiPost<OpenChatResult, { project_id: string }>(
      '/chat/open',
      { project_id: projectId },
      { signal },
    );
  },
  /**
   * Read the page of a conversation that comes before the one in hand.
   * @param conversationId - The conversation to reach further back in
   * @param beforeTurn - The oldest turn already on screen
   * @param signal - Raised when nobody is waiting for this page any more. The
   *   turn it was asked from is the previous visit's, so writing it into a
   *   list read since would put it above messages it does not join onto.
   * @returns That page, oldest first, and whether anything is older still
   */
  messagesBefore(
    conversationId: string,
    beforeTurn: number,
    signal?: AbortSignal,
  ): Promise<MessagePage> {
    return apiGet<MessagePage>(`/chat/conversations/${conversationId}/messages`, {
      params: { before_turn: beforeTurn },
      signal,
    });
  },
  listConversations(projectId: string) {
    return apiGet<{ conversations: ConversationSummary[] }>(
      '/chat/conversations',
      { params: { projectId } },
    );
  },
  /**
   * Read one conversation with the newest page of its messages.
   *
   * This is how switching conversations loads the one being switched into, so
   * it answers the same shape `/chat/open` does about its current one --
   * `hasMore` included, or the panel it lands in cannot know whether "load
   * earlier" has anything to load.
   * @param id - The conversation to read
   * @returns The conversation, its newest page, and whether it reaches further
   */
  readConversation(id: string): Promise<ConversationRead> {
    return apiGet<ConversationRead>(`/chat/conversations/${id}`);
  },
  /**
   * Start another conversation in a project.
   *
   * Distinct from `openChat`, which hands back the one already there. This
   * always makes a new one, because being given the existing conversation is
   * exactly what pressing "new conversation" is refusing.
   * @param projectId - Project the new conversation belongs to
   * @returns The conversation that was just created
   */
  createConversation(projectId: string): Promise<ConversationOnTheWire> {
    return apiPost<ConversationOnTheWire, { project_id: string }>(
      '/chat/conversations',
      { project_id: projectId },
    );
  },
  /**
   * Give a conversation a name.
   * @param id - The conversation being named
   * @param projectId - Project it lives in; the server checks this before
   *   writing, because the id came from here
   * @param title - The new name
   * @returns The conversation as it now stands
   */
  renameConversation(
    id: string,
    projectId: string,
    title: string,
  ): Promise<ConversationOnTheWire> {
    return apiPatch<ConversationOnTheWire, { project_id: string; title: string }>(
      `/chat/conversations/${id}`,
      { project_id: projectId, title },
    );
  },
  /**
   * Delete a conversation.
   * @param id - The conversation to delete
   * @returns When the server has deleted it
   */
  deleteConversation(id: string): Promise<void> {
    return apiDelete(`/chat/conversations/${id}`);
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
