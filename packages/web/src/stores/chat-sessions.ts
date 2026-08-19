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
import { tell } from '@web/stores/chat-mishaps';
import { DefaultChatTransport } from 'ai';
import type { StoredUiMessage } from '@web/data/api/chat';

/** What starting a conversation's state takes. */
export interface ChatSessionInit {
  /** The project it belongs to, which the server checks access against. */
  projectId: string;
  /**
   * Which conversation, and the key this is held under.
   *
   * Undefined while a panel is still finding out which one it is showing —
   * see {@link NOTHING_OPEN}.
   */
  conversationId: string | undefined;
  /**
   * What the store had for it, as the starting point.
   *
   * Used only when there is nothing here yet. A conversation already in this
   * map may have a turn in flight, and history read back while that is
   * happening is older than what is on screen.
   */
  history: StoredUiMessage[];
  /**
   * Called when the turn says what the conversation is called now.
   *
   * The server names a conversation from its first message and says so once,
   * on the stream. Nothing else carries it: the list is a page fetched when
   * the project was opened, and until it is fetched again the row would go on
   * saying the conversation has no name.
   *
   * Handed in rather than reached for, so that this module depends on nothing
   * above it.
   */
  onTitled: (title: string | null) => void;
}

/** The chunk the server names a conversation on. */
const TITLED = 'data-conversation-titled';

/** Every conversation whose state is being kept, by conversation id. */
const sessions = new Map<string, Chat<StoredUiMessage>>();

/**
 * What a panel subscribes to before it knows which conversation it is showing.
 *
 * A hook cannot be called conditionally, so a panel opening a project has to
 * subscribe to something during the round trip that tells it which
 * conversation that is. This one is empty and stays empty: nothing sends
 * through it, because sending reaches for the session by id at the moment of
 * the press rather than using whatever the last render subscribed to.
 */
const NOTHING_OPEN = new Chat<StoredUiMessage>({ id: 'no-conversation-yet', messages: [] });

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
 * Read a failed turn as the reader would hear it.
 *
 * What the transport throws for a refused turn is `new Error(responseText)`
 * (`ai@7.0.68` `dist/index.js:17351`) -- the body and nothing else, no status
 * on it. So a sentence of our own is recognised by its envelope: our errors
 * answer with `{ error: "..." }`, and anything else that answered is not ours
 * to quote.
 *
 * A conversation the server no longer has is one of these, and it gets the
 * same treatment as the rest: said, and left. Opening a replacement and
 * putting the words on it would leave the reader watching their own sentence
 * appear in a conversation they were not in, while the one on screen still
 * shows the history it always had.
 * @param error - Whatever the send threw.
 * @returns Which kind of mishap it is, and the server's own words if it wrote
 *   any.
 */
function readTurnFailure(error: unknown): { kind: 'server'; message: string } | { kind: 'turn' } {
  const body = error instanceof Error ? error.message : '';
  try {
    const envelope: unknown = JSON.parse(body);
    if (
      typeof envelope === 'object' &&
      envelope !== null &&
      'error' in envelope &&
      typeof envelope.error === 'string'
    ) {
      return { kind: 'server', message: envelope.error };
    }
  } catch {
    // Not JSON at all, which is what a gateway or a dropped connection
    // leaves. Falls through to the sentence the panel writes itself.
  }
  return { kind: 'turn' };
}

/**
 * Put a mark on the reply that was being written, if one was.
 *
 * The server writes the same mark into the row when it stores the turn, so
 * this is what a reader sees before that row is ever read back. Without it a
 * stopped turn and a failed one look on screen exactly like one that finished
 * -- until a reload, when the word appears out of nowhere.
 *
 * Only ever the last message, and only when it is a reply: a turn refused
 * before the model said anything has none, and the last message then is the
 * reader's own sentence, which nothing happened to.
 * @param chat - The session whose turn ended this way.
 * @param mark - Which of the two marks, in the protocol's naming.
 */
function markTheReply(chat: Chat<StoredUiMessage>, mark: 'data-interrupted' | 'data-failed'): void {
  const { messages } = chat;
  const reply = messages[messages.length - 1];
  if (reply === undefined || reply.role !== 'assistant') return;
  if (reply.parts.some((part) => part.type === mark)) return;
  chat.messages = [
    ...messages.slice(0, -1),
    { ...reply, parts: [...reply.parts, { type: mark, data: null }] },
  ];
}

/**
 * Stop the turn a conversation is running, as the reader asked.
 *
 * Stopping is what this end can do; whether the server sees it as the reader
 * stopping or as the connection dying, it records the turn the same way. The
 * mark says what this end knows, which is that the reply was cut off.
 * @param conversationId - The conversation to stop.
 */
export function stopChatSession(conversationId: string): void {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  void chat.stop();
  markTheReply(chat, 'data-interrupted');
}

/**
 * The state of one conversation, started if this is the first time it is asked
 * for.
 * @param init - Which conversation, and what the store had for it.
 * @returns Its `Chat`, the same one every time until it is evicted.
 */
export function chatSessionFor(init: ChatSessionInit): Chat<StoredUiMessage> {
  if (init.conversationId === undefined) return NOTHING_OPEN;

  const existing = sessions.get(init.conversationId);
  if (existing) return existing;

  const { projectId, conversationId, onTitled } = init;
  const chat = new Chat<StoredUiMessage>({
    id: conversationId,
    messages: init.history,
    transport: transportFor(projectId, conversationId),
    onData: (part) => {
      if (part.type !== TITLED) return;
      const { title } = part.data as { title: string | null };
      onTitled(title);
    },
    // On the instance rather than on `useChat`: the hook only keeps callbacks
    // it was given when it was not handed a chat.
    onError: (error) => {
      markTheReply(chat, 'data-failed');
      tell({ projectId, conversationId, ...readTurnFailure(error) });
    },
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
