// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useChat } from '@ai-sdk/react';

import { NOTICE_LINGERS_MS } from '@web/pages/project/chat/notice-timing';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import { visibleMessages } from '@web/pages/project/chat/visible-messages';

import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';
import type { OpenStatus, TurnPhase } from '@web/stores/conversation-runtime';
import { watchChatMishaps } from '@web/stores/chat-mishaps';
import type { ChatMishap } from '@web/stores/chat-mishaps';
import { chatSessionFor, sendInSession, stopChatSession } from '@web/stores/chat-sessions';
import type { StoredUiMessage } from '@web/data/api/chat';
import type { ConversationOnTheWire } from '@web/data/api/chat';
import type { ChatMessage } from '@web/pages/project/chat/types';

/**
 * How far along the turn is, from the status the SDK reports.
 *
 * Three of ours against four of theirs, and the join is deliberate: `error`
 * and `ready` are both "nothing is happening", which is what the composer
 * needs to know. What went wrong is said in a line of its own, not by leaving
 * the box unusable.
 * @param status - What the chat says it is doing.
 * @returns The phase the panel works in.
 */
function phaseOf(status: string): TurnPhase {
  if (status === 'submitted') return 'sending';
  if (status === 'streaming') return 'running';
  return 'idle';
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
   * reader is in: they pressed send and nothing has come back. What they can
   * do differs in all three -- send, wait, or stop.
   */
  turnPhase: TurnPhase;
  /**
   * The panel is on its way to another conversation.
   *
   * Separate from `turnPhase`, which is about the exchange inside the
   * conversation on screen. This one is about which conversation that is:
   * for as long as it is true, the one being shown is not the one the reader
   * just asked for.
   */
  navigating: boolean;
  /** A request for the next page of the conversation list is out. */
  loadingMore: boolean;
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
  /**
   * The last attempt at that page failed.
   *
   * While this is true the end of the list is not watched at all; a
   * single scroll is. A failure moves nothing, so an end still in view would
   * have the failure asking again on its own behalf, over and over. What asks
   * again is the reader moving.
   */
  nextPageFailed: boolean;
  /** The first page of the list is on its way. */
  listLoading: boolean;
  /**
   * What went wrong with something done to a row, for the list to say.
   *
   * Apart from {@link mishap} because the two are about different things and
   * either can be worth saying: this one belongs where the reader is looking,
   * which is inside a sheet that covers the panel's own line.
   */
  rowMishap: ChatMishap | null;
  /** Fetch the list again from its first page. */
  reloadList: () => void;
  /** Which one is on screen, for the list to mark. */
  currentId: string | undefined;
  /** What this conversation has half-typed, and how to change it. */
  draft: string;
  setDraft: (text: string) => void;
  /** Show a different conversation. */
  switchTo: (conversationId: string) => void;
  /** Name one. */
  rename: (conversationId: string, title: string) => void;
  /** Delete one, after the reader has confirmed. */
  remove: (conversationId: string) => void;
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
 * @param listOpen - Whether the conversation list is on screen, which decides
 *   where a word about one of its rows is drawn
 * @returns The messages, whether they have arrived, and what can be done
 */
export function useChatSession(projectId: string, listOpen = false): ChatSession {

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

  // The box is emptied when the first frame lands, and the session is what
  // says so. What separates the press from the first frame is whether
  // anything of this turn exists anywhere but in this browser: before, the
  // words are only in the box the reader typed them into, and a turn the
  // server refuses leaves them exactly there with nothing to put back.
  //
  // Told rather than watched, because this panel is not always here to watch:
  // collapsing the column or switching conversations unmounts it while the
  // turn goes on. A render-time watch would miss the turns whose first frame
  // lands in that gap, and empty the box a second time for the turns it comes
  // back to — over whatever the reader has typed since.
  const emptyTheBox = React.useCallback(
    (id: string) => (): void => conversationRuntime.setDraft(id, ''),
    [],
  );

  const chat = chatSessionFor({
    projectId,
    conversationId,
    history,
    onTitled: noteTitle(conversationId ?? ''),
    onFirstFrame: emptyTheBox(conversationId ?? ''),
  });
  const { messages: onScreen, status, error } = useChat({
    chat,
    throttle: UPDATE_THROTTLE_MS,
  });
  // The stretch of a send with no turn to carry the wait: the first message in
  // a project opens a conversation first, and that is a whole request during
  // which the SDK has not been asked for anything and says it is ready. Left
  // out, the composer draws a live send button through it.
  const opening = useConversationRuntime((s) => s.sendingByProject[projectId] === true);
  const turnPhase = opening ? 'sending' : phaseOf(status);
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

  const send = React.useCallback(
    async (draft: string): Promise<void> => {
      const said = draft.trim();
      if (said === '') return;
      // Which conversation this belongs in is settled at the press, not read
      // off the last render: a first message opens a conversation, and the
      // panel has not been told about it yet when this runs.
      const opened = await conversationRuntime.conversationForSending(projectId);
      if (opened === undefined) return;
      chatSessionFor({
        projectId,
        conversationId: opened,
        history: NO_MESSAGES,
        onTitled: noteTitle(opened),
        onFirstFrame: emptyTheBox(opened),
      });
      // Through the session rather than straight at the `Chat`: what a running
      // turn needs looking after -- the wait for the next beat, and giving up
      // when none comes -- lives with the session, and a send that went round
      // it would be a turn nobody was watching.
      await sendInSession(opened, said);
    },
    [projectId, noteTitle, emptyTheBox],
  );

  const abort = React.useCallback((): void => {
    if (conversationId) stopChatSession(conversationId);
  }, [conversationId]);

  const loadEarlier = React.useCallback((): void => {
    if (conversationId) void conversationRuntime.loadEarlier(conversationId);
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
  /**
   * The one that belongs in the list rather than in the panel.
   *
   * The list covers the whole column while it is open, so the panel's line --
   * on the top edge of the composer -- is a line nobody can read while it is
   * up. What decides is therefore where the reader is looking, not which
   * entrance they used: renaming can be started from the header too. Kept
   * apart from {@link mishap} rather than routed by whichever came last,
   * because the two are about different things and can both be worth saying.
   */
  const [rowMishap, setRowMishap] = React.useState<ChatMishap | null>(null);


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
        // A word about a row goes to the list only while the list is on
        // screen. Which entrance the reader used does not decide this -- the
        // header renames the conversation too, and the sheet is shut then, so
        // a line drawn inside it would be a line nobody reads.
        if (told.aboutRow === true && listOpen) {
          setRowMishap(told);
          return;
        }
        if (
          told.deliberate !== true &&
          told.conversationId !== null &&
          told.conversationId !== conversationId
        ) {
          return;
        }
        setMishap(told);
      }),
    [projectId, conversationId, listOpen],
  );

  React.useEffect(() => {
    if (mishap === null) return undefined;
    const forgetting = setTimeout(() => setMishap(null), NOTICE_LINGERS_MS);
    return () => clearTimeout(forgetting);
  }, [mishap]);

  React.useEffect(() => {
    if (rowMishap === null) return undefined;
    const forgetting = setTimeout(() => setRowMishap(null), NOTICE_LINGERS_MS);
    return () => clearTimeout(forgetting);
  }, [rowMishap]);

  // What the panel was handed for each message last time round.
  //
  // Every piece of a reply replaces that message, so this runs once per token.
  // Rebuilding all of it each time hands every bubble in the column a new
  // object, and a conversation is only ever appended to — one message is
  // changing and the rest were settled long ago. Keyed on the message object
  // itself, which the chat leaves untouched for everything it is not
  // rewriting, so identity is exactly the question "did this one change".
  const rendered = React.useRef(new Map<StoredUiMessage, ChatMessage>());

  const messages = React.useMemo(() => {
    // The one the reader just sent is held back until the answer starts: the
    // SDK pushes it and only then says the turn is under way, so a list that
    // drew everything would put the message up during the wait it is supposed
    // to be waiting through.
    const shown = visibleMessages(onScreen, status);
    const last = shown[shown.length - 1];
    const kept = new Map<StoredUiMessage, ChatMessage>();
    const out = shown.map((m) => {
      // What a reader needs announced is a failure they are living through,
      // not every failure the conversation ever had — those come back with the
      // history and would be read out again on every open. What tells the two
      // apart is the session's own error, which is set by the turn that failed
      // and cleared by the next one that starts.
      const justNow = error !== undefined && m === last && m.role === 'assistant';
      const streaming = status === 'streaming' && m === last && m.role === 'assistant';
      const before = rendered.current.get(m);
      // The comparisons matter on the message whose situation has just
      // changed while nothing about the message itself did.
      const view =
        before &&
        Boolean(before.failedJustNow) === justNow &&
        Boolean(before.streaming) === streaming
          ? before
          : toChatMessage(m, { failedJustNow: justNow, streaming });
      kept.set(m, view);
      return view;
    });
    rendered.current = kept;
    return out;
  }, [onScreen, status, error]);

  return {
    messages,
    status: openStatus,
    turnPhase,
    navigating,
    loadingMore,
    hasMore,
    mishap,
    loadEarlier,
    send,
    abort,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    nextPageFailed,
    listLoading,
    rowMishap,
    reloadList,
    currentId: conversationId,
    draft,
    setDraft,
    switchTo,
    rename,
    remove,
  };
}
