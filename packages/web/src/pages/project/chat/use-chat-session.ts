// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { MessageData } from '@breatic/shared';

import { useChatStore } from '@web/stores';

import {
  conversationRuntime,
  turnPhaseOf,
  useConversationRuntime,
  watchChatMishaps,
} from '@web/stores/conversation-runtime';
import type {
  ChatMessageData,
  ChatMishap,
  OpenStatus,
  TurnPhase,
} from '@web/stores/conversation-runtime';
import type { ConversationOnTheWire } from '@web/data/api/chat';
import type { ChatMessage, ToolCall } from '@web/pages/project/chat/types';

export interface ChatSession {
  /** Every message to show, history and the reply in flight alike. */
  messages: ChatMessage[];
  /** True until the server has answered — not the same as an empty chat. */
  isPending: boolean;
  /**
   * How far opening this project's chat has got.
   *
   * Read rather than collapsed into a boolean, because two different things
   * are decided by it and they are not the same question: whether there is a
   * conversation to render at all, and whether this wait has gone on long
   * enough to be worth showing.
   */
  status: OpenStatus;
  /**
   * How far along the turn is, if there is one.
   *
   * Three states and not a boolean, because the middle one is a state the
   * reader is in: they pressed send and nothing has come back. What they can
   * do differs in all three -- send, wait, or stop.
   */
  turnPhase: TurnPhase;
  /** The conversation reaches back further than the messages on screen. */
  hasMore: boolean;
  /**
   * What went wrong just now, for as long as that is still just now.
   *
   * Null the rest of the time, which is nearly always. Nothing that goes
   * wrong here is a state the chat is in — it is a thing that happened, at a
   * moment the reader was in, and it goes away on its own.
   */
  mishap: ChatMishap | null;
  /** Load the messages before the ones on screen. */
  loadEarlier: () => void;
  /**
   * Send what is in the composer, opening a conversation if there is not one.
   *
   * Takes the draft as it stands, whitespace and all; what goes out is the
   * trimmed message. The box is not this function's to write: the
   * conversation empties it when the server says the turn is stored, and
   * leaves it exactly as it is when nothing comes back.
   *
   * Never rejects. Whatever goes wrong is told to whoever is looking at the
   * moment it happens, and nothing on the screen moves for it.
   */
  send: (draft: string) => Promise<void>;
  /** Stop the turn in flight. */
  abort: () => void;
  /** The conversations fetched so far here, most recently used first. */
  conversations: ConversationOnTheWire[];
  /** The project has conversations older than the ones listed. */
  hasMoreConversations: boolean;
  /** Fetch the page after the ones listed. */
  loadMoreConversations: () => void;
  /** Which one is on screen, for the list to mark. */
  currentId: string | undefined;
  /** What this conversation has half-typed, and how to change it. */
  draft: string;
  setDraft: (text: string) => void;
  /** Show a different conversation. */
  switchTo: (conversationId: string) => void;
  /** Start another one and go to it. */
  startNew: () => void;
  /** Name one. */
  rename: (conversationId: string, title: string) => void;
  /** Delete one, after the reader has confirmed. */
  remove: (conversationId: string) => void;
}

/**
 * Adapt one stored message into what the panel renders.
 * @param message - The message as the store holds it
 * @param justFailed - This failure is happening now, with the reader waiting
 *   on it, rather than being read back out of the history
 * @returns The same message in the panel's shape
 */
function toChatMessage(message: ChatMessageData, justFailed: boolean): ChatMessage {
  const toolCalls: ToolCall[] = message.parts
    .filter((p) => p.type === 'tool')
    .map((p) => {
      const part = p as Extract<MessageData['parts'][number], { type: 'tool' }>;
      return {
        id: part.toolCallId,
        name: part.toolName,
        args: part.input,
        status: part.status,
        ...(part.output !== undefined ? { result: part.output } : {}),
        ...(part.errorMessage !== undefined ? { errorMessage: part.errorMessage } : {}),
      };
    });

  return {
    id: message.id ?? '',
    // A stored role is only ever one of these two; the panel's third is for
    // messages it makes up itself, which none of these are.
    role: message.role,
    content: message.content,
    ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(message.interrupted ? { interrupted: true as const } : {}),
    ...(message.failed ? { failed: true } : {}),
    ...(justFailed ? { failedJustNow: true as const } : {}),
    ...(message.streaming ? { streaming: true } : {}),
  };
}

/** What a panel is looking at before the conversation has arrived. */
const NO_MESSAGES: ChatMessageData[] = [];

/**
 * The list before one has arrived.
 *
 * Module-level, because an array built at each read is a changed value to
 * every subscriber -- and this one is read on every store change.
 */
const NO_CONVERSATIONS: ConversationOnTheWire[] = [];

/**
 * How long one line about something going wrong stays on screen.
 *
 * It goes away on its own because it is an event, not a state: the reader was
 * told, and a reader who was looking elsewhere is not owed it later. Four
 * seconds is what every other one-off message in this app lasts -- the toast
 * library's own default, which the rest of the product uses unchanged.
 */
const MISHAP_LINGERS_MS = 4000;

/**
 * The chat panel's view of the conversation it is showing.
 *
 * Reading only. What is happening in the conversation — the messages, and the
 * turn if one is running — belongs to the conversation and is held in
 * `stores/conversation-runtime`, so that collapsing the agent column is
 * collapsing a column rather than ending the answer the user is waiting for.
 * @param projectId - Project whose chat this is
 * @returns The messages, whether they have arrived, and what can be done
 */
export function useChatSession(projectId: string): ChatSession {
  const setActiveConversationId = useChatStore((s) => s.setActiveConversationId);

  const conversationId = useConversationRuntime((s) => s.currentByProject[projectId]);
  const openStatus = useConversationRuntime((s) => s.openStatus[projectId] ?? 'idle');
  const stored = useConversationRuntime(
    (s) => (conversationId ? s.conversations[conversationId]?.messages : undefined) ?? NO_MESSAGES,
  );
  const turnPhase = useConversationRuntime((s) => turnPhaseOf(s, projectId));
  const hasMore = useConversationRuntime((s) =>
    conversationId ? (s.conversations[conversationId]?.hasMore ?? false) : false,
  );
  const failures = useConversationRuntime((s) =>
    conversationId ? (s.conversations[conversationId]?.failures ?? 0) : 0,
  );
  const failedReplyId = useConversationRuntime((s) =>
    conversationId ? (s.conversations[conversationId]?.failedReplyId ?? null) : null,
  );
  const conversations = useConversationRuntime(
    (s) => s.listByProject[projectId] ?? NO_CONVERSATIONS,
  );
  const hasMoreConversations = useConversationRuntime(
    (s) => s.listHasMore[projectId] ?? false,
  );
  // Under the conversation when there is one, under the project until then --
  // typing while the open call is still out has to land somewhere.
  const draft = useConversationRuntime(
    (s) => s.draftByConversation[conversationId ?? `project:${projectId}`] ?? '',
  );

  React.useEffect(() => {
    void conversationRuntime.ensureLoaded(projectId);
  }, [projectId]);

  React.useEffect(() => {
    if (conversationId) setActiveConversationId(conversationId);
  }, [conversationId, setActiveConversationId]);

  /**
   * How many turns had already failed in this conversation when it came up.
   *
   * What a reader needs announced is a failure they are living through, not
   * every failure the conversation ever had — those come back with the
   * history and would be read out again on every open. The conversation
   * counts them; this remembers where the count stood when it arrived.
   *
   * Kept per conversation and not per mount. The count belongs to the
   * conversation and starts at zero in a new one, while the conversation on
   * screen can be replaced without this panel going anywhere — a press into
   * one another tab deleted opens a replacement. Held against a number
   * carried over from the conversation before it, the first failure in the
   * new one reads as old news and is never announced.
   */
  const arrivedAt = React.useRef({ conversationId, failures });
  if (arrivedAt.current.conversationId !== conversationId) {
    arrivedAt.current = { conversationId, failures };
  }
  const justFailed = failures > arrivedAt.current.failures ? failedReplyId : null;

  const send = React.useCallback(
    (draft: string): Promise<void> => conversationRuntime.send(projectId, draft),
    [projectId],
  );

  const abort = React.useCallback((): void => {
    if (conversationId) conversationRuntime.stopTurn(conversationId);
  }, [conversationId]);

  const loadEarlier = React.useCallback((): void => {
    if (conversationId) void conversationRuntime.loadEarlier(conversationId);
  }, [conversationId]);

  const setDraft = React.useCallback(
    (text: string): void => conversationRuntime.setDraft(projectId, conversationId, text),
    [projectId, conversationId],
  );

  const switchTo = React.useCallback(
    (id: string): void => void conversationRuntime.switchTo(projectId, id),
    [projectId],
  );

  const loadMoreConversations = React.useCallback(
    (): void => void conversationRuntime.loadMoreConversations(projectId),
    [projectId],
  );

  const startNew = React.useCallback(
    (): void => void conversationRuntime.startNew(projectId),
    [projectId],
  );

  const rename = React.useCallback(
    (id: string, title: string): void => void conversationRuntime.rename(projectId, id, title),
    [projectId],
  );

  const remove = React.useCallback(
    (id: string): void => void conversationRuntime.remove(projectId, id),
    [projectId],
  );

  /**
   * What just went wrong here, until it stops being just now.
   *
   * Watched rather than read out of the conversation, because a panel that is
   * not mounted watches nothing -- and that is the rule: what happens while
   * the reader is elsewhere is not told to them when they come back. They
   * come back to a conversation that stopped moving, which is how a reader of
   * a stream knows.
   */
  const [mishap, setMishap] = React.useState<ChatMishap | null>(null);

  React.useEffect(
    () =>
      watchChatMishaps((told) => {
        if (told.projectId !== projectId) return;
        // Only this conversation's. Another one may be streaming in the
        // background -- that is allowed -- and its trouble is not this
        // reader's to be interrupted by.
        // Except when the reader did it on purpose. Renaming or deleting a
        // conversation from the list is something they pressed and are waiting
        // to hear back about, and it is usually about a conversation other
        // than the one on screen -- that is what the list is for. The
        // question this filter asks is "is this the reader's own doing", not
        // "which conversation was it about".
        if (
          told.deliberate !== true &&
          told.conversationId !== null &&
          told.conversationId !== conversationId
        ) {
          return;
        }
        setMishap(told);
      }),
    [projectId, conversationId],
  );

  React.useEffect(() => {
    if (mishap === null) return undefined;
    const forgetting = setTimeout(() => setMishap(null), MISHAP_LINGERS_MS);
    return () => clearTimeout(forgetting);
  }, [mishap]);

  // What the panel was handed for each stored message last time round.
  //
  // Every piece of a reply replaces that message, so this runs once per token.
  // Rebuilding all of it each time hands every bubble in the column a new
  // object, and a conversation is only ever appended to — one message is
  // changing and the rest were settled long ago. Keyed on the stored message
  // itself, which the store leaves untouched for everything it is not
  // rewriting, so identity is exactly the question "did this one change".
  const rendered = React.useRef(new Map<ChatMessageData, ChatMessage>());

  const messages = React.useMemo(() => {
    const kept = new Map<ChatMessageData, ChatMessage>();
    const out = stored.map((m) => {
      const justNow = m.id === justFailed;
      const before = rendered.current.get(m);
      // The second half matters on the one message whose failure has just
      // stopped being news: nothing about it changed except that.
      const view =
        before && Boolean(before.failedJustNow) === justNow ? before : toChatMessage(m, justNow);
      kept.set(m, view);
      return view;
    });
    rendered.current = kept;
    return out;
  }, [stored, justFailed]);

  return {
    messages,
    isPending: openStatus === 'idle' || openStatus === 'loading',
    status: openStatus,
    turnPhase,
    hasMore,
    mishap,
    loadEarlier,
    send,
    abort,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    currentId: conversationId,
    draft,
    setDraft,
    switchTo,
    startNew,
    rename,
    remove,
  };
}
