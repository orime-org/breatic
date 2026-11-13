// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useChat } from '@ai-sdk/react';

import type { AskUserAnswer, ChatPendingItem, ChatSpaceContext, SpaceRequestAnswer } from '@breatic/shared';

import { joinContinued, splitAtAnswer, toChatMessage } from '@web/pages/project/chat/to-chat-message';

import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';
import type { OpenStatus, TurnPhase } from '@web/stores/conversation-runtime';
import { mishapLine, watchChatMishaps } from '@web/stores/chat-mishaps';
import { toast } from '@web/lib/toast';
import { chatAttachments } from '@web/stores/chat-attachments';
import { chatSessionFor } from '@web/stores/chat-sessions';
import { chatLive, useChatLive } from '@web/stores/chat-live';
import { NOTHING_WAITING, useChatWaiting, type WaitingArea } from '@web/stores/chat-waiting';
import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { clipSpaceContext } from '@web/pages/project/chat/space-context';
import type { ReadSpaces } from '@web/pages/project/chat/space-context';
import type { ConversationOnTheWire } from '@web/data/api/chat';
import type { ChatMessage } from '@web/pages/project/chat/types';

/**
 * Whether a run is being read, from the status the SDK reports while a
 * stream is resumed: `submitted` until its first frame, then `streaming`.
 * `error` and `ready` are both "nothing is being read".
 * @param status - What the chat says it is doing.
 * @returns True while a run is read.
 */
function readingRun(status: string): boolean {
  return status === 'submitted' || status === 'streaming';
}

export interface ChatSession {
  /** Every message to show, history and the reply in flight alike. */
  messages: ChatMessage[];
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
   * user is in: they pressed send and nothing has come back. What they can
   * do differs in all three -- send, wait, or stop.
   */
  turnPhase: TurnPhase;
  /**
   * The panel is on its way to another conversation.
   *
   * Separate from `turnPhase`, which is about the exchange inside the
   * conversation on screen. This one is about which conversation that is:
   * for as long as it is true, the one being shown is not the one the user
   * just asked for.
   */
  navigating: boolean;
  /** A request for the next page of the conversation list is out. */
  loadingMore: boolean;
  /** The conversation reaches back further than the messages on screen. */
  hasMore: boolean;
  /** Load the messages before the ones on screen; settles once the page has landed or failed. */
  loadEarlier: () => Promise<void>;
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
  /**
   * Answer the questionnaire the conversation on screen stopped at
   * (inner#1542); the turn that asked resumes. Resolves when that turn is over.
   */
  answer: (toolCallId: string, answers: AskUserAnswer['answers']) => Promise<void>;
  /**
   * Answer the request to look at Spaces the conversation on screen stopped
   * at (inner#1552); the turn that asked resumes. Resolves when that turn is
   * over.
   */
  shareSpaces: (answer: SpaceRequestAnswer) => Promise<void>;
  /** Stop the run the conversation on screen is running. */
  abort: () => void;
  /** A stop is on its way to the server. */
  stopping: boolean;
  /** The messages the server holds for the Agent to read, and why they wait. */
  waiting: WaitingArea;
  /** Take a waiting message back into the box, or delete it. */
  takeBack: (item: ChatPendingItem, how: 'retract' | 'delete') => void;
  /** The conversations fetched so far here, most recently used first. */
  conversations: ConversationOnTheWire[];
  /** The project has conversations older than the ones listed. */
  hasMoreConversations: boolean;
  /** Fetch the page after the ones listed. */
  loadMoreConversations: () => void;
  /**
   * The last attempt at that page failed.
   *
   * While this is true the end of the list is not watched at all; a
   * single scroll is. A failure moves nothing, so an end still in view would
   * have the failure asking again on its own behalf, over and over. What asks
   * again is the user moving.
   */
  nextPageFailed: boolean;
  /** The first page of the list is on its way. */
  listLoading: boolean;
  /** Fetch the list again from its first page. */
  reloadList: () => void;
  /** Which one is on screen, for the list to mark. */
  currentId: string | undefined;
  /** What this conversation has half-typed, and how to change it. */
  draft: string;
  setDraft: (text: string) => void;
  /** Show a different conversation. */
  switchTo: (conversationId: string) => void;
  /** Name one; rejects when the name was not saved. */
  rename: (conversationId: string, title: string) => Promise<void>;
  /** Delete one, after the user has confirmed; settles once the attempt is over. */
  remove: (conversationId: string) => Promise<void>;
}

/**
 * How often a streaming reply is allowed to redraw the panel, in milliseconds.
 *
 * SSE delivery is untouched: chunks arrive and land in the message as they
 * always did. This paces the notification that follows, which is what makes
 * React parse and rebuild the whole message again — measured in jsdom at 18.5ms
 * for an 8000-character reply, so a few dozen chunks a second would leave the
 * main thread nothing.
 *
 * The first chunk still shows immediately, intervening ones coalesce rather
 * than drop, and the last one always lands: `throttleit` runs the callback
 * straight away when the window has passed and queues it when it has not.
 */
const UPDATE_THROTTLE_MS = 50;

/** What a panel is looking at before the conversation has arrived. */
const NO_MESSAGES: StoredUiMessage[] = [];


/**
 * The list before one has arrived.
 *
 * Module-level, because an array built at each read is a changed value to
 * every subscriber -- and this one is read on every store change.
 */
const NO_CONVERSATIONS: ConversationOnTheWire[] = [];

/**
 * How a session reads its conversation's model at each send (#1363).
 * @param conversationId - The conversation.
 * @returns A reader of its model id, as the picker last set it.
 */
function modelOfConversation(conversationId: string): () => string | undefined {
  return () => useConversationRuntime.getState().conversations[conversationId]?.agentModel.id;
}

/**
 * The chat panel's view of the conversation it is showing.
 *
 * Reading only. What is happening in the conversation — the messages, and the
 * turn if one is running — belongs to the conversation and is held in the
 * `Chat` session `stores/chat-sessions` keeps for it, so that collapsing the
 * agent column is collapsing a column rather than ending the answer the user
 * is waiting for. `stores/conversation-runtime` holds what is around a
 * conversation rather than inside it: which one is on screen, the list, the
 * draft, and the page a session is first built from.
 * @param projectId - Project whose chat this is
 * @param readSpaces - Reads the user's Spaces as they stand, called at the
 *   press (inner#1413)
 * @returns The messages, whether they have arrived, and what can be done
 */
export function useChatSession(
  projectId: string,
  readSpaces: () => ReadSpaces,
): ChatSession {

  const conversationId = useConversationRuntime((s) => s.currentByProject[projectId]);
  const openStatus = useConversationRuntime((s) => s.openStatus[projectId] ?? 'idle');
  // What the store read back when this conversation was opened. It is the
  // starting point for its `Chat`, and after that the `Chat` is where the
  // messages live -- a turn in flight is not something the store knows about.
  const history = useConversationRuntime(
    (s) => (conversationId ? s.conversations[conversationId]?.messages : undefined) ?? NO_MESSAGES,
  );

  // Built once per conversation, so what it closes over never goes stale.
  const noteTitle = React.useCallback(
    (id: string) =>
      (title: string | null): void =>
        conversationRuntime.noteActivity(projectId, id, title),
    [projectId],
  );

  const chat = chatSessionFor({
    projectId,
    conversationId,
    history,
    onTitled: noteTitle(conversationId ?? ''),
  });
  const { messages: onScreen, status, error } = useChat({
    chat,
    throttle: UPDATE_THROTTLE_MS,
  });
  // From the press until the server answered: the first message in a project
  // opens a conversation first (held by the runtime), and every message waits
  // for its own answer (held by the live store).
  const sendHeld = useConversationRuntime((s) => s.sendingByProject[projectId] === true);
  const sending = useChatLive((s) => (conversationId === undefined ? false : s.sending[conversationId] === true));
  const stopping = useChatLive((s) => (conversationId === undefined ? false : s.stopping[conversationId] === true));
  const waiting = useChatWaiting((s) => (conversationId === undefined ? undefined : s.byConversation[conversationId])) ?? NOTHING_WAITING;
  const turnPhase: TurnPhase = sendHeld || sending ? 'sending' : readingRun(status) ? 'running' : 'idle';
  const navigating = useConversationRuntime((s) => s.navigatingByProject[projectId] === true);
  const loadingMore = useConversationRuntime((s) => s.listLoadingMore[projectId] === true);
  const hasMore = useConversationRuntime((s) =>
    conversationId ? (s.conversations[conversationId]?.hasMore ?? false) : false,
  );
  const conversations = useConversationRuntime(
    (s) => s.listByProject[projectId] ?? NO_CONVERSATIONS,
  );
  const hasMoreConversations = useConversationRuntime(
    (s) => s.listHasMore[projectId] ?? false,
  );
  const nextPageFailed = useConversationRuntime(
    (s) => s.listMoreFailed[projectId] ?? false,
  );
  const listLoading = useConversationRuntime((s) => s.listLoading[projectId] === true);
  // A draft belongs to the conversation it was typed in, and there is always
  // one: the box is read-only for the round trip before the first arrives.
  const draft = useConversationRuntime(
    (s) => (conversationId === undefined ? '' : (s.draftByConversation[conversationId] ?? '')),
  );

  React.useEffect(() => {
    void conversationRuntime.ensureLoaded(projectId);
  }, [projectId]);

  // The conversation on screen is the one kept in step with the server: it is
  // synced, and whatever run holds it is read (inner#1717). Collapsing the
  // column or switching away lets go of it; its run goes on on the server.
  React.useEffect(() => {
    if (conversationId === undefined) return undefined;
    chatLive.show(projectId, conversationId);
    return (): void => chatLive.hide(conversationId);
  }, [projectId, conversationId]);

  const send = React.useCallback(
    async (draft: string): Promise<void> => {
      const said = draft.trim();
      if (said === '') return;
      // Read before anything is waited on, so what goes is the Space as it
      // stood when send was pressed, not as it is once a conversation has
      // opened.
      const spaces = readSpaces();
      // Which conversation this belongs in is settled at the press, not read
      // off the last render: a first message opens a conversation, and the
      // panel has not been told about it yet when this runs.
      const opened = await conversationRuntime.conversationForSending(projectId);
      if (opened === undefined) return;
      // The Spaces are cut to the server's limits, so they cannot go without
      // them. The first read is a request, and the send stays held for it like
      // opening a conversation. A send whose user leaves the project or moves
      // to another conversation meanwhile does not go; the words stay in the
      // draft they were typed in, which leaving the project discards.
      const limits = await conversationRuntime.whileSendHeld(projectId, () =>
        chatApi.streamConfig().catch(() => null),
      );
      if (!conversationRuntime.stillSendingTo(projectId, opened)) return;
      chatSessionFor({
        projectId,
        conversationId: opened,
        history: NO_MESSAGES,
        onTitled: noteTitle(opened),
      });
      // What is above the box goes with it, all of it or not at all: an item
      // still uploading or one that failed holds the send, so what is sent is
      // what the user sees there.
      const attached = chatAttachments.sendable(opened);
      if (attached === null) return;
      // Said in a toast; the words stay in the box.
      if (limits === null) {
        chatAttachments.say({ key: 'sendUnavailable' });
        return;
      }
      const model = modelOfConversation(opened)();
      await chatLive.send({
        projectId,
        conversationId: opened,
        words: said,
        chips: attached,
        spaces: clipSpaceContext(spaces, limits, attached),
        ...(model === undefined ? {} : { model }),
      });
    },
    [projectId, noteTitle, readSpaces],
  );

  const answerCard = React.useCallback(
    async (send: (opened: string, spaces: ChatSpaceContext) => Promise<void>): Promise<void> => {
      // The card is in the conversation on screen, which is where it goes.
      // The Spaces are read at the press, as for a typed message.
      const opened = conversationId;
      if (opened === undefined) return;
      const spaces = readSpaces();
      const limits = await chatApi.streamConfig().catch(() => null);
      if (limits === null) {
        chatAttachments.say({ key: 'sendUnavailable' });
        return;
      }
      await send(opened, clipSpaceContext(spaces, limits, []));
    },
    [conversationId, readSpaces],
  );

  const answer = React.useCallback(
    (toolCallId: string, answers: AskUserAnswer['answers']): Promise<void> =>
      answerCard((opened, spaces) =>
        chatLive.answerCard({ projectId, conversationId: opened, toolCallId, card: { answer: { toolCallId, answers } }, spaces }),
      ),
    [answerCard, projectId],
  );

  const shareSpaces = React.useCallback(
    (shared: SpaceRequestAnswer): Promise<void> =>
      answerCard((opened, spaces) =>
        chatLive.answerCard({ projectId, conversationId: opened, toolCallId: shared.toolCallId, card: { shared_spaces: shared }, spaces }),
      ),
    [answerCard, projectId],
  );

  const abort = React.useCallback((): void => {
    if (conversationId) void chatLive.stop(projectId, conversationId);
  }, [projectId, conversationId]);

  const takeBack = React.useCallback(
    (item: ChatPendingItem, how: 'retract' | 'delete'): void => {
      if (conversationId) void chatLive.takeBack(projectId, conversationId, item, how);
    },
    [projectId, conversationId],
  );

  const loadEarlier = React.useCallback(async (): Promise<void> => {
    if (conversationId) await conversationRuntime.loadEarlier(conversationId);
  }, [conversationId]);

  const setDraft = React.useCallback(
    (text: string): void => conversationRuntime.setDraft(conversationId, text),
    [conversationId],
  );

  const switchTo = React.useCallback(
    (id: string): void => void conversationRuntime.switchTo(projectId, id),
    [projectId],
  );

  const loadMoreConversations = React.useCallback(
    (): void => void conversationRuntime.loadMoreConversations(projectId),
    [projectId],
  );

  /** Fetch the list again from its first page. */
  const reloadList = React.useCallback(
    (): void => void conversationRuntime.reloadConversationList(projectId),
    [projectId],
  );

  const rename = React.useCallback(
    (id: string, title: string): Promise<void> => conversationRuntime.rename(projectId, id, title),
    [projectId],
  );

  const remove = React.useCallback(
    (id: string): Promise<void> => conversationRuntime.remove(projectId, id),
    [projectId],
  );


  React.useEffect(
    () =>
      watchChatMishaps((told) => {
        if (told.projectId !== projectId) return;
        // Only this conversation's. Another one may be streaming in the
        // background -- that is allowed -- and its trouble is not this
        // user's to be interrupted by.
        // Except when the user did it on purpose. Renaming or deleting a
        // conversation from the list is something they pressed and are waiting
        // to hear back about, and it is usually about a conversation other
        // than the one on screen -- that is what the list is for. The
        // question this filter asks is "is this the user's own doing", not
        // "which conversation was it about".
        if (
          told.deliberate !== true &&
          told.conversationId !== null &&
          told.conversationId !== conversationId
        ) {
          return;
        }
        // Said once, as it happens (inner#1530). What happens while no panel
        // is mounted is not told when one comes back: the user comes back
        // to a conversation that stopped moving, which is how they know.
        toast.error(mishapLine(told));
      }),
    [projectId, conversationId],
  );

  // What the panel was handed for each message last time round.
  //
  // Every piece of a reply replaces that message, so this runs once per token.
  // Rebuilding all of it each time hands every bubble in the column a new
  // object, and a conversation is only ever appended to — one message is
  // changing and the rest were settled long ago. Keyed on the message object
  // itself, which the chat leaves untouched for everything it is not
  // rewriting, so identity is exactly the question "did this one change".
  // A reply resumed after a questionnaire is drawn as several (`splitAtAnswer`),
  // so one message can stand for more than one view.
  const rendered = React.useRef(new Map<StoredUiMessage, ChatMessage[]>());
  // Every part of a split reply but the last ends at an answered card and
  // changes no more, while the SDK replaces the message on every chunk; kept
  // by id and length so the streaming tail is the only view rebuilt.
  const settledParts = React.useRef(new Map<string, ChatMessage>());

  const messages = React.useMemo(() => {
    const shown = onScreen;
    const last = shown[shown.length - 1];
    const kept = new Map<StoredUiMessage, ChatMessage[]>();
    const keptParts = new Map<string, ChatMessage>();
    const out = shown.flatMap((m) => {
      // What a user needs announced is a failure they are living through,
      // not every failure the conversation ever had — those come back with the
      // history and would be read out again on every open. What tells the two
      // apart is the session's own error, which is set by the turn that failed
      // and cleared by the next one that starts.
      const justNow = error !== undefined && m === last && m.role === 'assistant';
      const streaming = status === 'streaming' && m === last && m.role === 'assistant';
      const before = rendered.current.get(m);
      const tail = before?.at(-1);
      // The comparisons matter on the message whose situation has just
      // changed while nothing about the message itself did. What is still
      // arriving, or has just failed, is the later half of a split reply.
      const views =
        before && tail && Boolean(tail.failedJustNow) === justNow && Boolean(tail.streaming) === streaming
          ? before
          : splitAtAnswer(m, { open: streaming }).map((half, i, halves) => {
            if (i === halves.length - 1) return toChatMessage(half, { failedJustNow: justNow, streaming });
            const key = `${half.id}#${String(half.parts.length)}`;
            const view = settledParts.current.get(key) ?? toChatMessage(half);
            keptParts.set(key, view);
            return view;
          });
      // Views carried over whole keep their settled parts for the next render.
      if (views === before) {
        for (const [key, view] of settledParts.current) if (views.includes(view)) keptParts.set(key, view);
      }
      kept.set(m, views);
      return views;
    });
    rendered.current = kept;
    settledParts.current = keptParts;
    return joinContinued(out);
  }, [onScreen, status, error]);

  return {
    messages,
    status: openStatus,
    turnPhase,
    navigating,
    loadingMore,
    hasMore,
    loadEarlier,
    send,
    answer,
    shareSpaces,
    abort,
    stopping,
    waiting,
    takeBack,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    nextPageFailed,
    listLoading,
    reloadList,
    currentId: conversationId,
    draft,
    setDraft,
    switchTo,
    rename,
    remove,
  };
}
