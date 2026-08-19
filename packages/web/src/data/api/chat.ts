// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ConversationEntity } from '@breatic/shared';
import type { UIMessage } from 'ai';

import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';

/**
 * What a stored message carries besides its parts.
 *
 * The server builds it in
 * `server/src/modules/conversation/message-part-mapping.ts`. Neither field is
 * the protocol's: the turn is how the next page back is asked for, and the
 * time is what the row was written at.
 */
export interface StoredMessageMetadata {
  /** The turn this message belongs to. */
  turnIndex: number;
  /** When the row was written, ISO-formatted. */
  ts: string;
}

/**
 * One message as it arrives from the server.
 *
 * The protocol's own shape, which is also the shape a conversation's `Chat`
 * session holds: what the server hands out is the starting point for one, so
 * a second shape in between would be a translation to maintain on this side.
 */
export type StoredUiMessage = UIMessage<StoredMessageMetadata>;

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
  messages: StoredUiMessage[];
  /** The conversation reaches back further than these messages do. */
  hasMore: boolean;
}

/** One page of a conversation, and whether anything is older. */
export interface MessagePage {
  /** The messages, oldest first. */
  messages: StoredUiMessage[];
  /** There are older messages than these. */
  hasMore: boolean;
}

/** One page of a project's conversations, and whether more follow it. */
export interface ConversationListPage {
  conversations: ConversationOnTheWire[];
  hasMore: boolean;
}

/** Everything the panel needs to render, from one call. */
export interface OpenChatResult {
  /** The first page of this user's conversations here, most recently used first. */
  conversations: ConversationOnTheWire[];
  /** The list goes on past that page, and the next one is a request away. */
  hasMoreConversations: boolean;
  /** The one to show, and what has been said in it. */
  current: {
    conversation: ConversationOnTheWire;
    messages: StoredUiMessage[];
    /** The conversation reaches back further than these messages do. */
    hasMore: boolean;
  };
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
  /**
   * One page of this project's conversations, most recently used first.
   *
   * `project_id` is the name the server reads. Spelling it any other way is
   * not rejected -- the filter simply goes missing, and the answer becomes
   * every conversation this user has in every project.
   * How many rows come back is the server's to decide -- it is a runtime knob
   * in `config/agent.yaml`, and the call that opens the panel reads the same
   * one. Naming a size here would be a second answer to that question.
   * @param projectId - The project to list.
   * @param after - The last row already held, or nothing for the first page.
   * @param after.updatedAt - When that row was last used.
   * @param after.id - Which row it is, for the rows that share an instant.
   * @param signal - Raised when the reader leaves the project.
   * @returns The page, and whether the list goes on past it.
   */
  listConversations(
    projectId: string,
    after?: { updatedAt: string; id: string },
    signal?: AbortSignal,
  ): Promise<ConversationListPage> {
    return apiGet<ConversationListPage>('/chat/conversations', {
      params: {
        project_id: projectId,
        ...(after ? { before_updated_at: after.updatedAt, before_id: after.id } : {}),
      },
      signal,
    });
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
};
