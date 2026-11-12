// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type {
  AgentModelChoice,
  ChatQueueRemoveAnswer,
  ChatRunningAnswer,
  ChatSendAnswer,
  ChatStopAnswer,
  ChatSyncAnswer,
  ConversationEntity,
  StoredMessageMetadata,
} from '@breatic/shared';
import type { UIMessage } from 'ai';

import { API_BASE_PATH } from '@web/data/api/base-path';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, runOnceRequest } from '@web/data/api/request';

/**
 * What a stored message carries besides its parts.
 *
 * The server builds it in
 * `server/src/modules/conversation/message-part-mapping.ts`. Neither field is
 * the protocol's: the turn is how the next page back is asked for, and the
 * time is what the row was written at.
 */

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

/**
 * A conversation as the open, read and create calls hand it over: with the
 * model it is answered by (#1363). The list's rows carry the stored pick only.
 */
export type ChatConversationOnTheWire = Omit<ConversationOnTheWire, 'agentModel'> & {
  agentModel: AgentModelChoice;
};

/** The models the user can pick, and the one a new conversation starts on (#1363). */
export interface ChatModels {
  models: AgentModelChoice[];
  /** The id of the model a new conversation of the user's starts on. */
  lastUsed: string;
}

/** One conversation with the newest page of what was said in it. */
export interface ConversationRead {
  conversation: ChatConversationOnTheWire;
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
    conversation: ChatConversationOnTheWire;
    messages: StoredUiMessage[];
    /** The conversation reaches back further than these messages do. */
    hasMore: boolean;
  };
}

/** The chat knobs a browser needs, from the server's config. */
export interface StreamConfig {
  /** How often this server says a running stream is alive, in milliseconds. */
  heartbeatIntervalMs: number;
  /** How long the attachments on one message may be, in characters. */
  attachmentMaxChars: number;
  /** How many items one message may carry. */
  attachmentMaxItems: number;
  /** How long the open Space's content one message carries may be, in characters. */
  currentSpaceMaxChars: number;
  /** How many of the project's Spaces one message may list. */
  spaceListMaxItems: number;
  /** How long one requested Space may take to sync before it is given up on, in milliseconds. */
  spaceReadTimeoutMs: number;
  /** How often an open conversation list asks which conversations are running, in milliseconds (#1394). */
  runningPollIntervalMs: number;
}

/**
 * What the server last said about its stream, so it is asked for once.
 *
 * The promise and not the answer, so that two conversations opening at the
 * same moment make one request between them rather than one each.
 */
let streamConfigAsked: Promise<StreamConfig> | null = null;

export const chatApi = {
  /**
   * How long to wait on a silent stream before deciding it is gone.
   *
   * Asked for rather than known: the beat is one number in
   * `config/agent.yaml`, and a copy of it here would be a second answer to a
   * question the server has already answered -- one that goes wrong silently,
   * because a browser waiting the wrong length of time neither errors nor
   * says anything.
   * @returns The knobs, from cache after the first call.
   */
  streamConfig(): Promise<StreamConfig> {
    streamConfigAsked ??= apiGet<StreamConfig>('/chat/stream-config').catch(
      (failed: unknown) => {
        // Not kept, so the next turn asks again. A cached rejection would
        // leave every later turn unwatched over one bad moment.
        streamConfigAsked = null;
        throw failed;
      },
    );
    return streamConfigAsked;
  },
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
   *   user has already left must not arrive at all.
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
   * @param signal - Raised when the user leaves the project.
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
   * The user's conversations in a project with an Agent turn running now, on
   * this page or any other tab or device (#1394).
   * @param projectId - The project.
   * @param signal - Aborts the request.
   * @returns Their ids, each once.
   */
  async running(projectId: string, signal?: AbortSignal): Promise<string[]> {
    const answer = await apiGet<ChatRunningAnswer>('/chat/running', { params: { project_id: projectId }, signal });
    return answer.conversation_ids;
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
   * @param key - The press's `Idempotency-Key`; a re-send with it makes nothing new
   * @returns The conversation that was just created
   */
  createConversation(projectId: string, key: string): Promise<ChatConversationOnTheWire> {
    return apiPost<ChatConversationOnTheWire, { project_id: string }>(
      '/chat/conversations',
      { project_id: projectId },
      runOnceRequest(key),
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
   * The models the user can pick in the chat panel, in order, and the one a
   * new conversation of theirs starts on (#1363).
   * @returns The list and the starting model's id
   */
  models(): Promise<ChatModels> {
    return apiGet<ChatModels>('/chat/models');
  },
  /**
   * Pick the model a conversation is answered by; it becomes the user's
   * last pick too (#1363).
   * @param id - The conversation
   * @param projectId - Project it lives in; the server checks this before writing
   * @param model - The model id
   * @returns The model the server saved for the conversation
   */
  async setModel(id: string, projectId: string, model: string): Promise<AgentModelChoice> {
    const saved = await apiPut<ChatConversationOnTheWire, { project_id: string; model: string }>(
      `/chat/conversations/${id}/model`,
      { project_id: projectId, model },
    );
    return saved.agentModel;
  },
  /**
   * Send a message, or a card's answer, to a conversation (inner#1717).
   *
   * The answer comes once the message is queued, and once a run it opened has
   * got through its opening; what the run says is read from `streamPath`.
   * No time limit: the opening may take as long as its checks do.
   * @param body - What is sent, or the reference a body over the size limit was stored under.
   * @param key - The press's `Idempotency-Key`; a re-send carries the same key and the same body.
   * @returns The status and the messages still waiting
   */
  sendMessage(body: object, key: string): Promise<ChatSendAnswer> {
    return apiPost<ChatSendAnswer, object>('/chat/message', body, runOnceRequest(key));
  },
  /**
   * Ask where a conversation stands; the server opens a run for what waits
   * when none holds it (inner#1717).
   * @param conversationId - The conversation
   * @param projectId - Project it lives in
   * @returns The waiting area, whether a run or a card holds it, and when to ask again
   */
  sync(conversationId: string, projectId: string): Promise<ChatSyncAnswer> {
    return apiPost<ChatSyncAnswer, { project_id: string }>(`/chat/conversations/${conversationId}/sync`, { project_id: projectId });
  },
  /**
   * Stop the run that holds a conversation, on whichever server it runs (inner#1717).
   * @param conversationId - The conversation
   * @param projectId - Project it lives in
   * @returns Whether a run was there to stop
   */
  stop(conversationId: string, projectId: string): Promise<ChatStopAnswer> {
    return apiPost<ChatStopAnswer, { conversation_id: string; project_id: string }>('/chat/stop', {
      conversation_id: conversationId,
      project_id: projectId,
    });
  },
  /**
   * Take a waiting message out of a conversation's queue (inner#1717).
   * @param conversationId - The conversation
   * @param messageId - The message
   * @param projectId - Project it lives in
   * @returns `removed` while it waited, `taken` once a run has read it, `gone` when it is nowhere
   */
  async removeQueued(conversationId: string, messageId: string, projectId: string): Promise<ChatQueueRemoveAnswer['status']> {
    const answer = await apiDelete<ChatQueueRemoveAnswer>(`/chat/conversations/${conversationId}/queue/${messageId}`, {
      data: { project_id: projectId },
    });
    return answer.status;
  },
  /**
   * Where the run that holds a conversation is read from (inner#1717).
   * @param conversationId - The conversation
   * @returns The path, under the API prefix
   */
  streamPath(conversationId: string): string {
    return `${API_BASE_PATH}/chat/conversations/${conversationId}/stream`;
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
