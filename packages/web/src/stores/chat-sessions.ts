// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The running state of each conversation, held where a panel cannot take it.
 *
 * A `Chat` instance holds one conversation's messages and whatever turn is in
 * flight. It lives here, keyed by conversation, so collapsing the agent column
 * is collapsing a column rather than ending the answer someone is waiting for
 * — and so is switching to another conversation and back.
 *
 * The same shape as `data/yjs/canvas-space.ts`'s `getCanvasUndoManager`: keyed
 * by the data rather than by a component, evicted by a named action rather
 * than by unmounting.
 *
 * Callbacks go to the instance and not to `useChat`. Measured on
 * `@ai-sdk/react@4.0.71` (`dist/index.js:301-311`): the hook only stores the
 * callbacks it was passed when it was *not* given a `chat`, so ones handed to
 * a `useChat({ chat })` are never called.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 6.3.
 */
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';

/**
 * What a stored message carries besides its parts.
 *
 * Mirrors what `POST /chat/open` sends; the server builds it in
 * `server/src/modules/conversation/message-part-mapping.ts`.
 */
export interface StoredMessageMetadata {
  /** The turn this message belongs to, which is what earlier pages are asked for by. */
  turnIndex: number;
  /** When the row was written, ISO-formatted. */
  ts: string;
}

/** One message as this app holds it. */
export type StoredUiMessage = UIMessage<StoredMessageMetadata>;

/** What starting a conversation's state takes. */
export interface ChatSessionInit {
  /** The project it belongs to, which the server checks access against. */
  projectId: string;
  /** Which conversation. Also the key this is held under. */
  conversationId: string;
  /**
   * What the store had for it, as the starting point.
   *
   * Used only when there is nothing here yet. A conversation already in this
   * map may have a turn in flight, and history read back while that is
   * happening is older than what is on screen.
   */
  history: StoredUiMessage[];
}

/** Every conversation whose state is being kept, by conversation id. */
const sessions = new Map<string, Chat<StoredUiMessage>>();

/**
 * Build the transport one conversation's turns go out on.
 *
 * The body is ours, not the protocol's: the server takes one message and the
 * ids that say where it belongs, and works out the history itself from what it
 * has stored. Sending the whole message list would be the browser telling the
 * server what the conversation contains.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation being written to.
 * @returns A transport pointed at the chat endpoint.
 */
function transportFor(
  projectId: string,
  conversationId: string,
): DefaultChatTransport<StoredUiMessage> {
  return new DefaultChatTransport<StoredUiMessage>({
    api: '/api/v1/chat/message',
    // The session cookie is what says who is asking, and a cross-origin
    // default would leave it off in any deployment where the API is not the
    // page's own origin.
    credentials: 'include',
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages[messages.length - 1];
      const said = (last?.parts ?? [])
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
      return {
        body: {
          message: said,
          project_id: projectId,
          conversation_id: conversationId,
          attached_chips: [],
        },
      };
    },
  });
}

/**
 * The state of one conversation, started if this is the first time it is asked
 * for.
 * @param init - Which conversation, and what the store had for it.
 * @returns Its `Chat`, the same one every time until it is evicted.
 */
export function chatSessionFor(init: ChatSessionInit): Chat<StoredUiMessage> {
  const existing = sessions.get(init.conversationId);
  if (existing) return existing;

  const chat = new Chat<StoredUiMessage>({
    id: init.conversationId,
    messages: init.history,
    transport: transportFor(init.projectId, init.conversationId),
  });
  sessions.set(init.conversationId, chat);
  return chat;
}

/**
 * Drop one conversation's state.
 *
 * For when the conversation itself is gone — deleted, or the project it was in
 * closed. Not for a panel unmounting: that is the case this whole module
 * exists to survive.
 * @param conversationId - Which one.
 */
export function evictChatSession(conversationId: string): void {
  sessions.get(conversationId)?.stop();
  sessions.delete(conversationId);
}

/**
 * Drop every conversation's state.
 *
 * For leaving a project, where what is being left is all of them at once.
 */
export function evictAllChatSessions(): void {
  for (const chat of sessions.values()) void chat.stop();
  sessions.clear();
}
