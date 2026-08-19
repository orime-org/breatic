// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Which conversation each project is showing, and what has been read of it.
 *
 * What is *happening* in a conversation -- the turn in flight and the messages
 * it is writing -- is the `Chat` session's, in `stores/chat-sessions`. This
 * holds the questions that outlive any one turn: which conversation is on
 * screen, what the list of them says, how far back the history has been read,
 * and what is half-typed in each box.
 *
 * The history read here is the starting point a `Chat` is built from. After
 * that the `Chat` is where the messages live, and this does not follow them:
 * a reply being written exists nowhere but in that session until the turn ends
 * and the server stores it.
 */

import { create } from 'zustand';

import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import type { ConversationOnTheWire, OpenChatResult } from '@web/data/api/chat';
import { evictChatSession } from '@web/stores/chat-sessions';
import { readMishap, tell } from '@web/stores/chat-mishaps';
import type { StoredUiMessage } from '@web/data/api/chat';

/**
 * How far along the turn a conversation is running is, if it is running one.
 *
 * Three states rather than two booleans, so the fourth combination -- running
 * and not sent -- cannot be written down.
 */
export type TurnPhase = 'idle' | 'sending' | 'running';

/** Everything known about one conversation. */
export interface ConversationRuntime {
  /** The project it belongs to, so leaving that project can find it. */
  projectId: string;
  /**
   * The history read back from the server, as the conversation's `Chat` was
   * started from. Not followed afterwards: the session owns the list from
   * there, and a reply being written is in no other place.
   */
  messages: StoredUiMessage[];
  /** The server has messages older than the ones loaded. */
  hasMore: boolean;
  /** The oldest turn loaded, which is where loading earlier starts from. */
  oldestLoadedTurn: number | null;
  /**
   * What this conversation is called, or null while it has no name.
   *
   * Here rather than only on its row in the list, because the list is one
   * page of a paged collection ordered by when each conversation was last
   * used -- open it again and the page is fetched afresh, and a conversation
   * nobody has spoken in for a while is not on it. A name read out of that
   * page vanishes with it, and the header then says the conversation has no
   * name, which is a different sentence from the one it had.
   */
  title: string | null;
}

/** How far opening one project's chat has got. */
export type OpenStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface ConversationRuntimeState {
  /** Keyed by conversation id. */
  conversations: Record<string, ConversationRuntime>;
  /** Which conversation each project is showing. */
  currentByProject: Record<string, string>;
  /**
   * Every conversation this reader has in a project, most recent first.
   *
   * Held apart from `conversations` because the two answer different
   * questions. That one holds what is being said, and only for the ones that
   * have been opened; this one is what the reader chooses from, and carries
   * nothing but what a row shows.
   */
  listByProject: Record<string, ConversationOnTheWire[]>;
  /**
   * The project has conversations older than the ones listed above.
   *
   * Answered by the server rather than worked out from the length of the list:
   * a page that filled the window and a page that happened to be the last one
   * look identical from here.
   */
  listHasMore: Record<string, boolean>;
  /**
   * The last attempt at the next page of conversations did not arrive.
   *
   * In the store because the panel renders it -- both as a line in the list
   * and as the thing that decides how the next attempt is asked for. Nothing
   * about a failed page moves, so the end of the list stays exactly where it
   * was and watching it again would report it again at once, which is the
   * failure retrying itself. While this is true the end is not watched at
   * all; a single scroll is, because a scroll is something only the reader
   * does.
   */
  listMoreFailed: Record<string, boolean>;
  /**
   * Which projects have a request out for the next page of conversations.
   *
   * Rendered at the foot of the list, so it lives here rather than beside the
   * store: reaching the end starts a whole round trip, and a list that gives
   * nothing back for it reads as one that did not notice.
   */
  listLoadingMore: Record<string, true>;
  /**
   * Which projects have the first page of the list on its way.
   *
   * "Nothing here" and "not known yet" are two different sentences, and the
   * list holds nothing in both cases. Saying the wrong one has the reader
   * close the list believing they misremembered, and find it populated a
   * second later. Both routes that fetch a first page raise it -- opening the
   * panel, and opening the list -- because it is one fact about the project,
   * not one fact per route.
   */
  listLoading: Record<string, true>;
  /**
   * Why this project's chat could not be read, when the server said why.
   *
   * The scrim covers the line that would otherwise carry it, so it has to say
   * it itself. Absent means there is no server sentence to quote here: either
   * nothing came back at all, or what came back was said somewhere else. The
   * scrim falls back to its own wording.
   */
  openFailure: Record<string, string>;
  /**
   * What is half-typed in each conversation, keyed by conversation.
   *
   * One per conversation and not one per panel: switching conversations puts
   * a different one in front of the reader, and a single draft would follow
   * them across as if they had typed it there.
   */
  draftByConversation: Record<string, string>;
  /** How far each project's open call has got. */
  openStatus: Record<string, OpenStatus>;
  /**
   * Which projects are on their way to another conversation.
   *
   * The one on screen is about to stop being the answer, so for as long as
   * this is true the composer is held still: what gets typed now would be
   * written into the conversation being left, and a box that looks usable but
   * does nothing when pressed is not the same as one that plainly cannot be
   * used. In the store rather than beside it because the panel renders it --
   * the count of navigations out is bookkeeping and stays outside.
   */
  navigatingByProject: Record<string, true>;
  /**
   * Which projects have a send under way that has no turn yet.
   *
   * A turn is the natural home for "something is being sent here", and it is
   * where this lives for all but the first moment of one. That moment is the
   * gap: pressing send when there is no conversation opens one first, a whole
   * request during which the turn does not exist. Waiting begins when the
   * reader presses, not when a conversation turns up to hold it, so the wait
   * needs somewhere to be recorded before there is a turn -- and the project
   * is what there is.
   */
  sendingByProject: Record<string, true>;
}

/**
 * Requests under way, so a second caller joins rather than asking again.
 *
 * Outside the state because a promise is not something to render; nothing
 * subscribes to these and putting them in state would make every subscriber
 * recompute when a request starts and again when it lands.
 *
 * Each entry carries who started it. A request left over from a previous visit
 * finishes long after the visit that made it, and an entry taken off by name
 * takes off whatever is there by then -- which is the current visit's, leaving
 * the next caller to ask the server all over again for something already on
 * its way.
 */
type InFlight<T = void> = Map<string, { work: Promise<T>; owner: symbol }>;

/**
 * What one request answered, and whether this caller is the one who made it.
 *
 * Two callers wanting the same thing share one request, and some of what is
 * owed for it is owed once rather than once each -- a line about it having
 * failed, above all. So the answer comes back saying which of the two this
 * caller is.
 */
interface Answered<T> {
  /** What the request answered. The same value for everyone waiting on it. */
  answer: T;
  /** This call is the one that made the request, rather than joining it. */
  started: boolean;
}

/**
 * Do this once per key, and let anyone asking meanwhile wait on the same one.
 * @param entries - Where requests of this kind are registered.
 * @param key - What the request is about: a project, or a conversation.
 * @param start - Makes the request. Must not reject; nothing here can catch.
 * @returns What it answered, and whether this call is the one that asked.
 */
async function joinOrStart<T>(
  entries: InFlight<T>,
  key: string,
  start: () => Promise<T>,
): Promise<Answered<T>> {
  const joined = entries.get(key);
  if (joined) return { answer: await joined.work, started: false };

  const owner = Symbol(key);
  const work = (async (): Promise<T> => {
    try {
      return await start();
    } finally {
      if (entries.get(key)?.owner === owner) entries.delete(key);
    }
  })();
  entries.set(key, { work, owner });
  return { answer: await work, started: true };
}

/**
 * What opening a chat answered with when it could not.
 *
 * Wrapped rather than handed back bare, so that "it did not work" is a
 * different answer from "it worked" whatever was thrown.
 */
interface OpenFailure {
  /** Whatever the call threw, for whoever decides what to say about it. */
  failed: unknown;
}

/** Chats being opened, keyed by project. */
const opening: InFlight<OpenFailure | undefined> = new Map();


/**
 * Earlier pages already being fetched, keyed by the conversation and the
 * cursor the page is asked from.
 *
 * A second press joins the request in flight rather than making another one.
 * Two requests would answer with the same page and both would be written to
 * the head of the list, so the reader would be shown every earlier message
 * twice -- and this is a button, which is the one thing readers press twice.
 * Keying the request by what it asks for and joining the one in flight is how
 * every library that fetches for a view does this: SWR calls it deduping,
 * RTK Query keys it by endpoint and arguments, Apollo has it on by default.
 */
const loadingEarlier: InFlight = new Map();
/**
 * Forget every page still on its way to one conversation.
 *
 * Pages are registered under the conversation *and* the cursor they ask from
 * (see `loadEarlier`), so there can be more than one, and none of them can be
 * found by the conversation's name alone.
 * @param conversationId - The conversation being left behind.
 */
function forgetEarlierPages(conversationId: string): void {
  for (const key of [...loadingEarlier.keys()]) {
    if (key.startsWith(`${conversationId}:`)) loadingEarlier.delete(key);
  }
}


/**
 * The visit each project is currently on.
 *
 * A reader who finds a project slow to open backs out and comes in again --
 * which is the ordinary answer to a slow screen, not an unusual sequence. The
 * first visit's requests are still running when the second one starts, and
 * their answers replace what is on screen: the open call rebuilds the whole
 * conversation, turn and all, and the earlier page is written to the head of
 * a list it no longer joins onto.
 *
 * "Is this project still on screen" cannot tell the two visits apart, because
 * coming back makes it true again. This can: every request carries the signal
 * of the visit that asked for it, leaving raises that signal, and a raised
 * signal stays raised -- so an answer to a visit the reader has left can
 * neither arrive nor be written. It is what Apollo Client does when an
 * observer unsubscribes, and cancelling is the only property the check needs.
 */
const visits = new Map<string, AbortController>();

/**
 * The visit a project is on, starting one if it is not on any.
 * @param projectId - The project being visited.
 * @returns Its visit, whose signal is raised when the reader leaves.
 */
function currentVisit(projectId: string): AbortController {
  const existing = visits.get(projectId);
  if (existing) return existing;
  const started = new AbortController();
  visits.set(projectId, started);
  return started;
}

const useStore = create<ConversationRuntimeState>()(() => ({
  conversations: {},
  currentByProject: {},
  listByProject: {},
  listHasMore: {},
  listMoreFailed: {},
  listLoadingMore: {},
  listLoading: {},
  openFailure: {},
  draftByConversation: {},
  openStatus: {},
  navigatingByProject: {},
  sendingByProject: {},
}));

/**
 * Apply a change to one conversation, if it is still there.
 * @param conversationId - The conversation to change.
 * @param change - Applied to it, returning the replacement.
 */
function patchConversation(
  conversationId: string,
  change: (c: ConversationRuntime) => ConversationRuntime,
): void {
  useStore.setState((s) => {
    const current = s.conversations[conversationId];
    if (!current) return s;
    return { conversations: { ...s.conversations, [conversationId]: change(current) } };
  });
}

/**
 * The oldest turn among a batch of messages.
 *
 * Which turn a message belongs to rides in its metadata, put there by the
 * server when it hands the history out. Asking the next page from the oldest
 * one on screen is the only thing it is for.
 * @param messages - The batch, as the server handed it out.
 * @returns That turn, or null when the batch is empty.
 */
function oldestTurnOf(messages: readonly StoredUiMessage[]): number | null {
  return messages.length > 0
    ? Math.min(...messages.map((m) => m.metadata?.turnIndex ?? 0))
    : null;
}

/**
 * Open one project's chat, once.
 *
 * Does nothing when it is already open, and joins the request in flight when
 * one is. There is no automatic refetch behind this and that is the point: a
 * refetch landing mid-turn replaces the list with a snapshot taken before the
 * turn existed, taking the reply off the screen while it is still arriving.
 * @param projectId - The project whose chat to open.
 * @returns When there is a conversation to write to, or the attempt failed.
 */
async function ensureLoaded(projectId: string): Promise<void> {
  if (useStore.getState().openStatus[projectId] === 'ready') return;
  const { answer: failure, started } = await joinOrStart(opening, projectId, () =>
    openAndAdopt(projectId),
  );
  // Said here rather than where it happened, because whether it is worth
  // saying depends on what the caller was going to do about it. This caller
  // was going to show the chat, and now there is none to show.
  //
  // Once per failed request, not once per caller: a press made while the
  // panel's own request is still out joins that request rather than making a
  // second one, and one request that failed is one line owed. The caller that
  // asked is the one that answers for it.
  if (failure && started) {
    tell({ projectId, conversationId: null, ...readMishap(failure.failed) });
  }
}

/**
 * Ask the server for this project's chat and put the answer on screen.
 *
 * Never rejects, and says nothing: what went wrong is handed back, because
 * one of the callers is a send that is going to try again and a line about a
 * failure that healed itself is a line about nothing.
 *
 * Written once because all three callers owe the reader the same things --
 * the same status while it runs, the same check that the visit which asked is
 * still the one on screen. They are: opening the chat, a turn that finds its
 * conversation gone, and removing the last conversation there was. The first
 * two arrive through {@link joinOrStart}; the third calls straight in, so the
 * word about a failure is `remove`'s to say. Having its own copy of this was
 * how one of them came to leave the status saying `loading` for ever.
 * @param projectId - The project whose chat to open.
 * @returns What went wrong, or nothing when there is a conversation on screen
 *   -- and nothing as well when the visit that asked is over, which is not a
 *   failure anyone is owed a word about.
 */
async function openAndAdopt(projectId: string): Promise<OpenFailure | undefined> {
  const nav = intendToNavigate(projectId);
  let landed = false;
  // Taken here rather than inside, because asking again further down would
  // answer about whichever visit is current by then, not the one that asked.
  const visit = currentVisit(projectId);
  firstPageStarted(projectId);
  useStore.setState((s) => ({ listLoading: { ...s.listLoading, [projectId]: true as const } }));
  try {
    // Everything except a chat that is already on screen. What this must not do
    // is take a conversation away from someone reading it: the message column
    // draws nothing while this says loading, so a re-open behind a chat that
    // works would blank it -- and a re-open is something a press causes, so the
    // reader would press send and watch their conversation disappear.
    //
    // A chat that could not be read has nothing to take away. Saying loading
    // there is the whole of what a retry looks like: the scrim goes, the wait is
    // shown, and a second failure brings the scrim back. Without it the retry
    // button changed nothing on screen at all -- the only word about it went to
    // the notice line, which that same scrim is covering.
    useStore.setState((s) =>
      s.openStatus[projectId] === 'ready'
        ? s
        : { openStatus: { ...s.openStatus, [projectId]: 'loading' } },
    );
    try {
      const opened = await chatApi.openChat(projectId, visit.signal);
      if (visit.signal.aborted) return undefined;
      // The reader can press "new conversation" while this is still out -- the
      // header is drawn before the answer arrives. What they pressed is later
      // than this, so the conversation they made is the one to stay on; only
      // the list below is still worth taking.
      // Two separate questions, and being overtaken answers only one of them.
      // Which conversation to show: not this one, the reader has since chosen
      // another. What the list holds: this answer, still -- it was assembled
      // before they chose, so it lacks what they made, but it has everything
      // else. Dropping it whole would leave the sheet showing one row where the
      // project has dozens, and take `hasMore` with it, so paging could not
      // recover them either.
      // A press that failed takes its navigation back, so being overtaken here
      // means something later actually stands -- and this answer, assembled
      // before it, must not replace what the reader chose.
      landed = stillAwaited(projectId, nav);
      if (landed) adoptConversation(projectId, opened.current);
      // A page already on its way was asked for from the end of the list this
      // answer is about to settle, and the count is how that page finds out.
      // Both ways out of the setState below bump it, not only the replacing
      // one: being overtaken keeps the held list and appends to it, so that
      // cursor still points at a row somebody holds. Dropping the page anyway
      // costs the reader one more scroll; keeping one that turns out to be
      // about a list nobody holds costs a gap in the middle of the list, and
      // a `hasMore` that closes paging for the rest of this visit.
      listReplaced(projectId);
      useStore.setState((st) => {
        const held = st.listByProject[projectId] ?? [];
        const standing = opened.conversations;
        const listed = landed
          ? standing
          : [...held, ...standing.filter((c) => !held.some((h) => h.id === c.id))];
        return {
          conversations: withNames(st.conversations, listed),
          listByProject: { ...st.listByProject, [projectId]: listed },
          listHasMore: { ...st.listHasMore, [projectId]: opened.hasMoreConversations },
          // The mark said the last attempt at the next page did not arrive.
          // This answer is the whole list again, so that sentence is about a
          // list nobody is holding any more -- and left standing it would both
          // show the reader an error belonging to something else and keep the
          // paging gate shut, since the gate is read before the mark is
          // cleared.
          listMoreFailed: { ...st.listMoreFailed, [projectId]: false },
        };
      });
      return undefined;
    } catch (err) {
      // Except when the visit that asked is over, which includes this refusal
      // being the abort itself. Reporting it then would have the caller replace
      // a conversation the reader is looking at now with the news that a
      // request they walked away from did not work.
      if (visit.signal.aborted) return undefined;
      // Only while this is still the navigation being waited for. Something
      // the reader pressed later takes the question away from this one: what
      // is on its way then is theirs, and the panel is waiting for that, not
      // failing at this. Saying otherwise raises a scrim over a wait that is
      // about to end -- and if that later press lands, over a conversation
      // that works.
      // Nor over a chat that has opened before: there is a conversation on
      // screen and it is still readable, so saying it could not be opened
      // would take it away over a request the reader did not make.
      if (stillAwaited(projectId, nav) && useStore.getState().openStatus[projectId] !== 'ready') {
        markUnreadable(projectId, err);
      }
      return { failed: err };
    }
  } finally {
    // Both unconditional: the count pairs on every exit, and whether the flag
    // still belongs on screen is a question about the count, not about who
    // brought it to zero. Guarding this one left a square nobody clears --
    // the trip that reaches zero can be one already abandoned, and the trip
    // before it saw a count that was not zero yet.
    firstPageEnded(projectId);
    settleListLoading(projectId);
    // However this ended -- landed, failed, or overtaken -- it is over, and
    // being the last one out means nobody else will settle the panel.
    navigationEnded(projectId, nav, landed);
  }
}

/**
 * Put a conversation and its newest page on screen for a project.
 *
 * Rebuilds the entry rather than merging into it: this is an answer describing
 * the whole conversation, so what it does describe replaces what was held.
 * A turn still running here is the exception, and the reason is the same one
 * -- it is the part of this conversation the answer does not describe, because
 * it has not reached the server yet. It is carried across, along with the
 * reply being written and the failures shown beside it. That is also why
 * callers must not reach here with an answer to a visit that is over -- see
 * {@link visits} -- and why every one of them checks first.
 * @param projectId - The project showing it.
 * @param opened - The conversation, its newest page, and whether the
 *   conversation reaches back further than that page does.
 */
function adoptConversation(projectId: string, opened: OpenChatResult['current']): void {
  const conversationId = opened.conversation.id;
  // The name the answer carries is written as it came. Two answers about the
  // same conversation are settled by which lands last -- nothing here weighs
  // one against the other, and a name that reads as stale for a moment is put
  // right the next time the list is opened.
  //
  // Called here for the copy the list draws: the setState below rebuilds the
  // conversation whole, name included, but never touches `listByProject`.
  applyTitle(projectId, conversationId, opened.conversation.title ?? null);
  useStore.setState((s) => ({
    openStatus: { ...s.openStatus, [projectId]: 'ready' },
    // Whatever went wrong last time is over. A reason kept past it would
    // be shown as the reason for whatever goes wrong next.
    openFailure: (({ [projectId]: _gone, ...rest }) => rest)(s.openFailure),
    currentByProject: { ...s.currentByProject, [projectId]: conversationId },
    conversations: {
      ...s.conversations,
      [conversationId]: {
        projectId,
        // What the server holds, which is not everything on screen: a turn
        // under way is writing a reply the server has not stored yet. That
        // one is the session's and stays there -- this page is only ever the
        // starting point a session is built from, and a session that already
        // exists keeps the list it has.
        messages: opened.messages,
        hasMore: opened.hasMore,
        oldestLoadedTurn: oldestTurnOf(opened.messages),
        title: opened.conversation.title ?? null,
      },
    },
  }));
}

/** The one refusal a second attempt can do anything about. */
const NOT_FOUND = 404;

/**
 * Did the server say this conversation is already gone.
 *
 * Not the same as a request that failed. It is our own answer, and what it
 * says is that the thing being asked about is not there -- which for a delete
 * is the outcome the reader wanted. Another tab of theirs having deleted it is
 * how it usually got that way.
 *
 * The status alone is not enough. A proxy answering 404 for a path it does not
 * know sends the same number, and nothing of ours is in that answer -- so the
 * refusal has to be one our server wrote before it is read this way.
 * @param err - What the request threw.
 * @returns True when our server said there is no such conversation.
 */
function alreadyGone(err: unknown): boolean {
  return err instanceof ApiException && err.fromServer && err.status === NOT_FOUND;
}

/**
 * The conversation a press should be written into, opened if there is not one.
 *
 * Everything about *which* conversation stays here; what happens inside it is
 * the `Chat` session's. The two are settled at different moments and this is
 * the earlier one: a first message opens a conversation, and the panel has
 * not been told about it yet when the press is handled.
 *
 * A navigation in flight is on its way to replace what is on screen, so a
 * press during one would be written into the conversation being left: the
 * words and the reply both vanish when the switch lands, while that turn goes
 * on running and being charged for. Only when there is one on screen -- a
 * press with no conversation yet is a different thing, and opens one.
 * @param projectId - The project being sent to.
 * @returns Which conversation, or undefined when there is none to write to.
 */
async function conversationForSending(projectId: string): Promise<string | undefined> {
  const state = useStore.getState();
  if (state.currentByProject[projectId] !== undefined && awaitedNavigationInFlight(projectId)) {
    return undefined;
  }
  if (state.currentByProject[projectId] === undefined) {
    await whileOpening(projectId, () => ensureLoaded(projectId));
  }
  return useStore.getState().currentByProject[projectId];
}

/**
 * Hold the project's send mark for as long as this takes.
 *
 * For the stretches of a send with no turn to carry the wait -- opening a
 * conversation, and opening a replacement for one the server no longer has.
 * Both are a whole request long, and both used to leave a live send button up.
 * @param projectId - The project being sent to.
 * @param work - What to do while the mark is up. Must not reject.
 * @returns Whatever the work answered.
 */
async function whileOpening<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  useStore.setState((s) => ({
    sendingByProject: { ...s.sendingByProject, [projectId]: true as const },
  }));
  try {
    return await work();
  } finally {
    useStore.setState((s) => {
      if (!s.sendingByProject[projectId]) return s;
      const { [projectId]: _sending, ...rest } = s.sendingByProject;
      return { sendingByProject: rest };
    });
  }
}

/**
 * Load the messages before the ones on screen.
 *
 * Written to the head of the list, which is the half no turn touches: a reply
 * being streamed is appended to the tail, so the two writers never contend.
 * @param conversationId - The conversation to reach further back in.
 * @returns When the page has been written, or the attempt failed. Never
 *   rejects: the caller is a click handler, and there is nothing there to
 *   catch one.
 */
async function loadEarlier(conversationId: string): Promise<void> {
  const before = useStore.getState().conversations[conversationId];
  if (!before || !before.hasMore || before.oldestLoadedTurn === null) return;
  const beforeTurn = before.oldestLoadedTurn;
  const visit = currentVisit(before.projectId);

  // Keyed by what it asks for, not just who it asks about. A second press
  // after the list has moved on asks from a different cursor, and joining the
  // one still on its way would be waiting on a page that is going to be
  // dropped -- the reader would have pressed a button and had nothing happen.
  await joinOrStart(loadingEarlier, `${conversationId}:${beforeTurn}`, async (): Promise<void> => {
    try {
      const earlier = await chatApi.messagesBefore(conversationId, beforeTurn, visit.signal);
      // `beforeTurn` was read from the list this visit is looking at. If the
      // visit is over, the list has been read again from the top, and putting
      // this page at its head would leave everything between them missing
      // with nothing on screen saying so -- and move the cursor past the gap,
      // so no press could ever ask for it.
      if (visit.signal.aborted) return;
      // And the list has to still reach back to where this page was asked
      // from. A turn beginning replaces the whole list with the server's own
      // page, which starts somewhere else entirely; putting this one at its
      // head leaves the same gap for the same reason.
      if (useStore.getState().conversations[conversationId]?.oldestLoadedTurn !== beforeTurn) {
        return;
      }
      patchConversation(conversationId, (c) => ({
        ...c,
        messages: [...earlier.messages, ...c.messages],
        hasMore: earlier.hasMore,
        oldestLoadedTurn: oldestTurnOf(earlier.messages) ?? c.oldestLoadedTurn,
      }));
    } catch (err) {
      // Except when the visit is over, which includes this failure being the
      // abort itself: nobody asked for this page any more.
      if (visit.signal.aborted) return;
      // Told once. The button is still there and still says there is more, so
      // pressing it again is how the reader tries again -- and being told
      // again is what tells them it failed again.
      tell({ projectId: before.projectId, conversationId, ...readMishap(err) });
    }
  });
}

/**
 * Say this project's chat could not be read, and why.
 *
 * The status and the reason are one fact, so they are written in one place.
 * Left to each failing path to remember, the scrim ends up wearing a reason
 * from some earlier failure, or none at all while the server had said exactly
 * what was wrong.
 * @param projectId - The project.
 * @param err - What came back.
 */
function markUnreadable(projectId: string, err: unknown): void {
  const why = readMishap(err);
  useStore.setState((s) => ({
    openStatus: { ...s.openStatus, [projectId]: 'failed' as OpenStatus },
    openFailure:
      why.kind === 'server'
        ? { ...s.openFailure, [projectId]: why.message }
        : (({ [projectId]: _gone, ...rest }) => rest)(s.openFailure),
  }));
}

/**
 * The navigations still out for each project, by the number they took.
 *
 * Answers one question only: is anyone else still going to finish this. A
 * navigation that ends removes itself, so an empty set means the last one out
 * has to settle the panel -- nobody is left who could.
 *
 * It cannot answer the other question, whether the reader is still waiting for
 * a particular one. Leaving the set is what every navigation does when it
 * ends, the newest included; asking who is highest among those left would then
 * promote an older one still travelling, and its stale answer would replace
 * what the reader actually chose. That question goes to {@link claimed}, which
 * names the one navigation the reader is waiting for.
 */
const inFlight = new Map<string, Set<number>>();

/**
 * Record that the reader has asked to be somewhere in this project.
 * @param projectId - The project being navigated.
 * @returns The number to check back with, and to end with.
 */
function intendToNavigate(projectId: string): number {
  const flying = inFlight.get(projectId) ?? new Set<number>();
  const next = (lastIssued.get(projectId) ?? 0) + 1;
  flying.add(next);
  inFlight.set(projectId, flying);
  lastIssued.set(projectId, next);
  claimed.set(projectId, next);
  useStore.setState((s) => ({
    navigatingByProject: { ...s.navigatingByProject, [projectId]: true as const },
  }));
  return next;
}

/**
 * The number of the last navigation asked for, per project.
 *
 * Answers "is the reader still waiting for me": only the newest can be, and
 * this is the only record that survives a navigation ending. It never goes
 * backwards, so a number is never handed out twice and a stale answer can
 * never pass for the current one.
 */
const lastIssued = new Map<string, number>();

/**
 * Whether the navigation the reader is waiting for is still on its way.
 *
 * Asked by whoever is about to act on the conversation that is on screen now:
 * while it is true, that conversation is about to stop being the answer. An
 * overtaken navigation does not count -- it cannot replace anything any more,
 * so waiting on it holds the reader back for an answer nobody will use.
 * @param projectId - The project being asked about.
 * @returns Whether the awaited navigation is out for it.
 */
function awaitedNavigationInFlight(projectId: string): boolean {
  const flying = inFlight.get(projectId);
  const awaited = claimed.get(projectId);
  return awaited !== undefined && flying !== undefined && flying.has(awaited);
}

/**
 * Whether the reader is still waiting for the navigation with this number.
 * @param projectId - The project.
 * @param token - What {@link intendToNavigate} handed back.
 * @returns True while nothing later is still on its way.
 */
function stillAwaited(projectId: string, token: number): boolean {
  return claimed.get(projectId) === token;
}

/**
 * The navigation whose answer the reader is currently waiting for.
 *
 * Separate from {@link lastIssued} because a press that fails asked for
 * nothing in the end: the claim goes back to the newest one still travelling,
 * whose answer is what the reader wants again. Separate from {@link inFlight}
 * because that one forgets a navigation the moment it ends, including the
 * newest -- and then an older one still on its way would look like the latest
 * word.
 */
const claimed = new Map<string, number>();

/**
 * The highest number that has actually put a conversation on screen.
 *
 * A navigation that failed hands its claim back to whatever is still
 * travelling, and without this that could be a number older than what is on
 * screen -- its answer was assembled before the conversation the reader is
 * looking at existed, so letting it land takes that conversation away from
 * them and drops the row for it. Nothing older than this is anybody's wish
 * any more.
 */
const lastLanded = new Map<string, number>();

/**
 * A navigation is over, however it ended.
 *
 * Every route that takes a number must reach here, once, whether it landed,
 * failed, or was overtaken. Being the last one out carries a duty: saying
 * `loading` promised the reader a conversation, and if nothing else is still
 * travelling then nobody else can keep that promise. Left alone the panel
 * holds a skeleton that turns for ever -- no conversation, no scrim, and so
 * no way to ask again.
 * @param projectId - The project.
 * @param token - What {@link intendToNavigate} handed back.
 * @param landed - It put a conversation on screen.
 */
function navigationEnded(projectId: string, token: number, landed: boolean): void {
  const flying = inFlight.get(projectId);
  flying?.delete(token);
  if (landed) lastLanded.set(projectId, Math.max(lastLanded.get(projectId) ?? -1, token));
  if (!landed && claimed.get(projectId) === token) {
    // This press asked for nothing in the end, so it stops outranking the
    // others. Whatever is still travelling is the reader's wish again -- the
    // newest of those, since the older ones were already overtaken -- but only
    // if it is newer than what is on screen. An older one cannot be a wish:
    // its answer was assembled before the conversation the reader is looking
    // at, and handing the claim to it lets that answer replace them.
    const newest = flying === undefined || flying.size === 0 ? undefined : Math.max(...flying);
    const stillGoing =
      newest !== undefined && newest > (lastLanded.get(projectId) ?? -1) ? newest : undefined;
    if (stillGoing === undefined) claimed.delete(projectId);
    else claimed.set(projectId, stillGoing);
  }
  // Two different questions, and they were being answered by one test.
  //
  // The composer is held still while the conversation on screen is about to be
  // replaced. A navigation that has been overtaken cannot replace it any more,
  // so what matters is whether the one the reader is waiting for is still
  // travelling -- not whether anything is. Pressing the row already on screen
  // ends the wait at once; leaving the box frozen until an abandoned answer
  // turns up makes the reader wait on something that will be thrown away.
  if (!awaitedNavigationInFlight(projectId)) {
    useStore.setState((s) => ({
      navigatingByProject: (({ [projectId]: _done, ...rest }) => rest)(s.navigatingByProject),
    }));
  }
  // Settling the panel is the other question: an overtaken navigation still
  // has to come back before nobody is left who could take `loading` off the
  // screen, so this one does wait for all of them.
  if (flying !== undefined && flying.size > 0) return;
  useStore.setState((s) =>
    s.openStatus[projectId] === 'loading'
      ? {
        openStatus: { ...s.openStatus, [projectId]: 'failed' as OpenStatus },
        // Nothing came back to quote: what failed was some request whose own
        // sentence went to the notice line. A reason still held here is from
        // an earlier failure and must not be worn as this one's.
        openFailure: (({ [projectId]: _gone, ...rest }) => rest)(s.openFailure),
      }
      : s,
  );
}

/**
 * Write a conversation's name into the list the reader chooses from.
 * @param projectId - The project whose list to change.
 * @param conversationId - The conversation being named.
 * @param title - Its name now, or null if it still has none.
 */
function applyTitle(projectId: string, conversationId: string, title: string | null): void {
  useStore.setState((s) => {
    // The conversation first, because that is where the name lives. Its row in
    // the list is a second copy for the list to draw, and there may not be one
    // -- the list holds one page, and this conversation need not be on it.
    const held = s.conversations[conversationId];
    const conversations = held
      ? { ...s.conversations, [conversationId]: { ...held, title } }
      : s.conversations;
    const listed = s.listByProject[projectId];
    if (!listed) return { conversations };
    return {
      conversations,
      listByProject: {
        ...s.listByProject,
        [projectId]: listed.map((c) => (c.id === conversationId ? { ...c, title } : c)),
      },
    };
  });
}

/**
 * Record that something was just said in a conversation.
 *
 * Three things at once, because they are one event. The name, which the server
 * decides on the first message and mentions nowhere else on the stream. The
 * time, which the row shows and which the server will not say again until
 * the list is fetched afresh -- which is the next time the project is opened,
 * or the drawer is. And the order, because the list is sorted
 * most recently used first and that is the order `remove` reads to pick where
 * to land -- a list that never re-sorts makes both of those wrong the moment
 * the reader speaks in anything but the top one.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation just spoken in.
 * @param title - What it is called now, or null if it still has no name.
 */
function noteActivity(projectId: string, conversationId: string, title: string | null): void {
  useStore.setState((s) => {
    // The name reaches the conversation whatever the list holds. Speaking in
    // one that is not on the page in hand still names it, and the header reads
    // the name from here.
    const held = s.conversations[conversationId];
    const conversations = held
      ? { ...s.conversations, [conversationId]: { ...held, title } }
      : s.conversations;
    const listed = s.listByProject[projectId];
    const spokenIn = listed?.find((c) => c.id === conversationId);
    if (!listed || !spokenIn) return { conversations };
    const now = new Date().toISOString();
    return {
      conversations,
      listByProject: {
        ...s.listByProject,
        [projectId]: [
          { ...spokenIn, title, updatedAt: now },
          ...listed.filter((c) => c.id !== conversationId),
        ],
      },
    };
  });
}

/**
 * Read one conversation and put it on screen, under a navigation already taken.
 *
 * The two callers -- a reader picking a row, and a delete landing on the next
 * row -- owe the same things: check the visit is still on, check this is still
 * the navigation being waited for, and say the same thing when it fails. The
 * number is passed in rather than taken here, because both of them have work
 * of their own under it: the delete has a row to remove first.
 * They part on one thing, and it is a decision rather than an accident. A
 * switch that fails leaves the conversation on screen readable, so nothing is
 * covered. A delete that fails to land on the next row is different: the
 * delete itself may or may not have gone through, so the list in hand cannot
 * be trusted, and the way to say that is the scrim with its reload.
 * @param projectId - The project this happens in.
 * @param conversationId - The conversation to read.
 * @param nav - The navigation number both the caller and this share.
 * @param coverOnFailure - Raise the scrim if this does not land.
 * @returns Whether it put that conversation on screen.
 */
async function readAndAdopt(
  projectId: string,
  conversationId: string,
  nav: number,
  coverOnFailure = false,
): Promise<boolean> {
  const visit = currentVisit(projectId);
  try {
    const read = await chatApi.readConversation(conversationId);
    if (visit.signal.aborted) return false;
    if (!stillAwaited(projectId, nav)) return false;
    adoptConversation(projectId, read);
    return true;
  } catch (err) {
    // The conversation on screen is still readable -- this says nothing about
    // it. Covering the column would take away one that works, along with the
    // stop button of whatever turn is running in it. The scrim belongs to an
    // open that failed, where there is no conversation on screen to take away.
    if (visit.signal.aborted) return false;
    // Only while this landing is still the one being waited for: the reader
    // may have picked a row themselves in the meantime and be reading it, and
    // blacking out the column over a conversation they left would take away
    // one that works.
    if (coverOnFailure && stillAwaited(projectId, nav)) markUnreadable(projectId, err);
    tell({
      projectId,
      conversationId,
      deliberate: true,
      // Our own 404 is not a failure: the server answered, and what it said is
      // that this one is not there any more -- usually because another tab of
      // theirs deleted it. The row stays; the next time the list is opened it
      // is fetched afresh anyway.
      ...(alreadyGone(err) ? ({ kind: 'gone' } as const) : readMishap(err)),
    });
    return false;
  }
}

/**
 * Show a different conversation in this project.
 *
 * The one being switched into is read in full rather than assembled from the
 * list, because a list row carries no messages -- landing on it with what the
 * list knows would show an empty conversation, which is the same thing a
 * failure looks like.
 * @param projectId - The project doing the switching.
 * @param conversationId - The conversation to show.
 */
async function switchTo(projectId: string, conversationId: string): Promise<void> {
  // Taken before the early return below, not after. Picking the row already on
  // screen is still the reader saying where they want to be, and it has to
  // cancel whatever is on its way -- otherwise a switch they started and then
  // changed their mind about lands anyway, a moment later.
  const nav = intendToNavigate(projectId);
  let landed = false;
  try {

    // Already the one on screen. Asking again would replace a conversation with
    // an identical copy of itself for no reason -- but this press did put the
    // reader where they asked to be, so it counts as having landed. Counting it
    // as a press that asked for nothing would hand the claim back to whatever
    // is still travelling, and the switch they just changed their mind about
    // would arrive a moment later and take the screen.
    if (useStore.getState().currentByProject[projectId] === conversationId) {
      landed = true;
      return;
    }

    landed = await readAndAdopt(projectId, conversationId, nav);
  } finally {
    // However this ended -- landed, failed, or overtaken -- it is over, and
    // being the last one out means nobody else will settle the panel.
    navigationEnded(projectId, nav, landed);
  }
}

/**
 * Start another conversation in this project and go to it.
 *
 * Nothing on screen moves until the server has made it. The alternative --
 * switching first and reconciling after -- would take the reader out of the
 * conversation they were in, along with whatever they had half-typed there,
 * on the strength of a request that may be about to fail.
 * @param projectId - The project to start one in.
 */
async function startNew(projectId: string): Promise<void> {
  const nav = intendToNavigate(projectId);
  let landed = false;
  try {
    const visit = currentVisit(projectId);
    try {
      const created = await chatApi.createConversation(projectId);
      if (visit.signal.aborted) return;
      // A switch started before this press may still be out. It was asked for
      // first and will answer whenever it answers, but this is what the reader
      // asked for last, so the row it creates is the one to land on -- and the
      // check inside that switch will see this number and leave the screen
      // alone.
      // The row goes in either way. This conversation exists on the server now,
      // and a list that leaves it out is wrong about what the project holds --
      // being overtaken only decides which conversation to land on.
      useStore.setState((s) => ({
        listByProject: {
          ...s.listByProject,
          // At the top, where the list's order puts the most recently used one.
          [projectId]: [created, ...(s.listByProject[projectId] ?? [])],
        },
        // Never having been answered means the first page never arrived, and
        // this row is then the whole of what the list holds. What came before
        // it is unknown, which is not the same as nothing: saying nothing
        // would close paging for good, and reaching the end of a list of one
        // is how the reader would otherwise get those conversations back --
        // the page after this row is exactly the page that failed to arrive.
        listHasMore:
          s.listHasMore[projectId] === undefined
            ? { ...s.listHasMore, [projectId]: true }
            : s.listHasMore,
      }));
      if (!stillAwaited(projectId, nav)) return;
      adoptConversation(projectId, { conversation: created, messages: [], hasMore: false });
      landed = true;
    } catch (err) {
      if (visit.signal.aborted) return;
      // Not `aboutRow`: the only way to press this is the header's button,
      // and pressing it closes the sheet, so there is no list to draw against
      // by the time this is said. Closing is right -- a reader starting a new
      // conversation is done with the list of the old ones.
      tell({ projectId, conversationId: null, deliberate: true, ...readMishap(err) });
    }
  } finally {
    // However this ended -- landed, failed, or overtaken -- it is over, and
    // being the last one out means nobody else will settle the panel.
    navigationEnded(projectId, nav, landed);
  }
}

/**
 * Projects with a request out for their next page of conversations.
 *
 * Reaching the bottom of a list fires as often as the reader keeps scrolling,
 * and every one of those would ask for the same page again: one request per
 * scroll event, all for the same cursor. The rows themselves are safe -- the
 * answers are filtered against the ids already held -- but the requests are
 * not, and neither is the line at the foot of the list, which each of them
 * would raise and lower in turn.
 */
const fetchingMore = new Set<string>();

/**
 * How many requests are out for the *first* page of conversations, by project.
 *
 * Two routes fetch it -- opening the panel and opening the list -- and both
 * write the whole list rather than appending to it. A count and not a set,
 * because with a set the first of two overlapping requests to finish would
 * clear the one membership and leave the other saying nothing is on its way
 * while it still is.
 */
const fetchingList = new Map<string, number>();

/**
 * Which list a project is holding, counted up each time it is replaced whole.
 *
 * The next page is asked for from the last row held, so its cursor describes
 * the list in hand at that moment. Replace the list whole and that cursor is
 * about a list nobody holds any more -- appending its answer leaves a gap
 * where the rows between the two lists were, and the `hasMore` it carries can
 * close paging on a list that is not finished, with nothing on screen to say
 * so.
 */
const listGeneration = new Map<string, number>();

/**
 * Note that a project's list was replaced whole.
 * @param projectId - The project whose list it is.
 */
function listReplaced(projectId: string): void {
  listGeneration.set(projectId, (listGeneration.get(projectId) ?? 0) + 1);
}

/**
 * Which list this project is holding.
 * @param projectId - The project whose list it is.
 * @returns A number that changes whenever the list is replaced whole.
 */
function listNow(projectId: string): number {
  return listGeneration.get(projectId) ?? 0;
}
/**
 * Take the names an answer carries into the conversations this end holds.
 *
 * The name lives on the conversation and the row is a copy for the list to
 * draw (invariant 7), so a list answer that only reached the row would leave
 * the header saying one thing and the row another -- and nothing would put
 * them back: picking the row already on screen does not read it again.
 *
 * Whatever the answer says is what gets written -- nothing is weighed against
 * anything. Two answers about the same conversation are settled by which of
 * them lands last, and a name that reads as stale for a moment is corrected
 * by the next time the list is opened.
 * @param held - The conversations this end holds.
 * @param rows - The rows the answer carried.
 * @returns The conversations, under the names now known.
 */
function withNames(
  held: Record<string, ConversationRuntime>,
  rows: readonly { id: string; title: string | null }[],
): Record<string, ConversationRuntime> {
  const renamed = rows.filter((r) => {
    const c = held[r.id];
    return c !== undefined && c.title !== r.title;
  });
  if (renamed.length === 0) return held;
  const next = { ...held };
  for (const r of renamed) next[r.id] = { ...next[r.id]!, title: r.title };
  return next;
}
/**
 * Note that a request for the first page has gone out.
 * @param projectId - The project it is for.
 */
function firstPageStarted(projectId: string): void {
  fetchingList.set(projectId, (fetchingList.get(projectId) ?? 0) + 1);
}

/**
 * Note that one has come back, however it ended.
 *
 * Called on every exit, including the ones belonging to a visit that is over:
 * this is a count of requests in flight, and increments and decrements have to
 * pair. Leaving it out on the abandoned path left the count stuck above zero,
 * and the gate that stops two requests for the same page then refused every
 * later one -- the list could never be fetched again.
 * @param projectId - The project it was for.
 */
function firstPageEnded(projectId: string): void {
  const left = (fetchingList.get(projectId) ?? 1) - 1;
  if (left > 0) fetchingList.set(projectId, left);
  else fetchingList.delete(projectId);
}

/**
 * Fetch the page of conversations after the ones already listed.
 *
 * Does nothing while a request is already out, and nothing when the list is
 * known to be complete. It continues from the last row held rather than from a
 * count of rows: this list is ordered by when each conversation was last used,
 * so it moves while the reader pages through it, and a count would land
 * somewhere other than where the last page ended.
 *
 * A failure leaves the rows already listed exactly as they are and says so
 * once. What could not be read is the part that has not arrived yet, not the
 * part that has; the list is still known to have more, and reaching the end
 * again asks again.
 * @param projectId - The project whose list to extend.
 */
async function loadMoreConversations(projectId: string): Promise<void> {
  const state = useStore.getState();
  if (!state.listHasMore[projectId]) return;
  if (fetchingMore.has(projectId)) return;

  const held = state.listByProject[projectId];
  // Nothing held means the first page has not arrived, and the first page is
  // `openChat`'s to fetch. Asking from here would race it and append a second
  // copy of everything it is about to write.
  if (held === undefined || held.length === 0) return;
  const last = held[held.length - 1];

  const visit = currentVisit(projectId);
  const asked = listNow(projectId);
  fetchingMore.add(projectId);
  useStore.setState((st) => ({
    listMoreFailed: { ...st.listMoreFailed, [projectId]: false },
    listLoadingMore: { ...st.listLoadingMore, [projectId]: true as const },
  }));
  try {
    const page = await chatApi.listConversations(
      projectId,
      { updatedAt: last.updatedAt, id: last.id },
      visit.signal,
    );
    if (visit.signal.aborted) return;
    // The list this continues from has been replaced since, so this answer is
    // about a list nobody holds. It cannot be laid over the one that took its
    // place: the rows between the two lists would be missing, and the
    // `hasMore` it carries could close paging on a list that is not finished.
    // Dropped, and nothing takes its place: the list that replaced this one
    // says for itself whether there is more, and reaching *its* end is what
    // asks next. Asking here would hand the reader a page they never scrolled
    // to -- the end they reached belonged to a list that is gone.
    if (listNow(projectId) !== asked) return;
    useStore.setState((s) => {
      const current = s.listByProject[projectId] ?? [];
      // The page starts after the last row held, so in an order that has not
      // moved these are all new. It can move, though -- another tab, or this
      // one, may have written a row in the meantime -- and a list is one row
      // per conversation whatever happened in between.
      const known = new Set(current.map((c) => c.id));
      const fresh = page.conversations.filter((c) => !known.has(c.id));
      return {
        conversations: withNames(s.conversations, fresh),
        listByProject: { ...s.listByProject, [projectId]: [...current, ...fresh] },
        listHasMore: { ...s.listHasMore, [projectId]: page.hasMore },
      };
    });
  } catch {
    if (visit.signal.aborted) return;
    // Said at the foot of the list and nowhere else. The panel's own line is
    // under the sheet while the list is open, and the list is the only place
    // this can be reached from -- a second copy there would surface later,
    // when the sheet closes, about something the reader has moved on from.
    useStore.setState((st) => ({
      listMoreFailed: { ...st.listMoreFailed, [projectId]: true },
    }));
  } finally {
    // Only if this is still the visit that asked. Both of these are per
    // project, and a request abandoned with a visit lands whenever it lands --
    // by then the reader may have come back and asked again. Clearing then
    // takes down the line saying a page is on its way while one still is, and
    // opens the gate that stops the same page being asked for twice.
    if (!visit.signal.aborted) {
      fetchingMore.delete(projectId);
      useStore.setState((st) => ({
        listLoadingMore: (({ [projectId]: _done, ...rest }) => rest)(st.listLoadingMore),
      }));

    }
  }
}

/**
 * Fetch the first page of the list again, replacing what is held.
 *
 * Opening the list is a moment to fetch: where the reader had paged to, and
 * what they saw, belong to the last time they opened it -- and in between,
 * another tab of theirs may have started conversations, deleted them, or
 * renamed them. Replacing rather than merging is the point: rows that are
 * gone have to go, and merging keeps them.
 *
 * It clears the mark left by a page that failed, which is the other half. The
 * mark takes the end-of-list watcher off duty until the reader scrolls, and a
 * list too short to scroll gives them no way to do that -- so without this a
 * single failed page would end paging for the rest of the visit.
 * @param projectId - The project whose list to fetch again.
 */
async function reloadConversationList(projectId: string): Promise<void> {
  if (fetchingList.has(projectId)) return;

  const visit = currentVisit(projectId);
  firstPageStarted(projectId);
  useStore.setState((st) => ({ listLoading: { ...st.listLoading, [projectId]: true as const } }));
  try {
    const page = await chatApi.listConversations(projectId, undefined, visit.signal);
    if (visit.signal.aborted) return;
    listReplaced(projectId);
    useStore.setState((st) => {
      const standing = page.conversations;
      return {
        conversations: withNames(st.conversations, standing),
        listByProject: { ...st.listByProject, [projectId]: standing },
        listHasMore: { ...st.listHasMore, [projectId]: page.hasMore },
        listMoreFailed: { ...st.listMoreFailed, [projectId]: false },
      };
    });
  } catch (err) {
    if (visit.signal.aborted) return;
    // Said in the list, because this only ever runs while the list is open --
    // opening it is what asks. A line on the composer's top edge would be
    // under the sheet, which is the very fault this branch set out to fix.
    tell({
      projectId,
      conversationId: null,
      deliberate: true,
      aboutRow: true,
      ...readMishap(err),
    });
  } finally {
    // Both unconditional, for the reason given where `openAndAdopt` does the
    // same: the flag follows the count, not the visit.
    firstPageEnded(projectId);
    settleListLoading(projectId);
  }
}

/**
 * Stop saying the first page is on its way, if nothing is fetching one.
 *
 * Two routes fetch a first page and either can be the last one out, so
 * neither can clear the flag on its own account.
 * @param projectId - The project to settle.
 */
function settleListLoading(projectId: string): void {
  if (fetchingList.has(projectId)) return;
  useStore.setState((st) => ({
    listLoading: (({ [projectId]: _done, ...rest }) => rest)(st.listLoading),
  }));
}


/**
 * Give a conversation the name its owner typed.
 *
 * The list is written only once the server has stored it. Showing the new name
 * first would leave a row saying something the server never accepted, and the
 * reader has no way to tell the two apart.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation being named.
 * @param title - The name the reader typed.
 */
async function rename(
  projectId: string,
  conversationId: string,
  title: string,
): Promise<void> {
  const visit = currentVisit(projectId);
  try {
    const renamed = await chatApi.renameConversation(conversationId, projectId, title);
    if (visit.signal.aborted) return;
    applyTitle(projectId, conversationId, renamed.title);
  } catch (err) {
    if (visit.signal.aborted) return;
    tell({ projectId, conversationId, deliberate: true, aboutRow: true, ...readMishap(err) });
  }
}

/**
 * Delete a conversation, and go somewhere sensible if it was the one on screen.
 *
 * Where "somewhere sensible" is: the next one in the list, which is ordered
 * most recently used first, so it is the one the reader was in before this.
 * When it was the only one, chat is opened again -- and opening a project with
 * no conversation makes one, which is the same answer the reader would get by
 * leaving and coming back.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation to delete.
 */
async function remove(projectId: string, conversationId: string): Promise<void> {
  const visit = currentVisit(projectId);

  try {
    await chatApi.deleteConversation(conversationId);
  } catch (err) {
    if (visit.signal.aborted) return;
    // Our own "that conversation is gone" is not a failure to delete it: it is
    // already deleted, which is what the reader asked for. Another tab of
    // theirs is how it usually got that way. Treating it as a failure left a
    // row that could never be removed -- every press answered the same way.
    // Anything else, the row stays: a list that has lost a conversation the
    // server still has is worse than one that failed to lose it, because only
    // the second is something the reader can retry.
    if (!alreadyGone(err)) {
      tell({ projectId, conversationId, deliberate: true, aboutRow: true, ...readMishap(err) });
      return;
    }
  }
  if (visit.signal.aborted) return;

  // Whatever it was running stops with it. Leaving the turn to finish would
  // go on calling the model, and being billed for it, on behalf of a
  // conversation that no longer exists. Dropping the session from the map is
  // not enough on its own -- the request is out, and nothing about a map
  // entry disappearing reaches it.
  evictChatSession(conversationId);

  const remaining = (useStore.getState().listByProject[projectId] ?? []).filter(
    (c) => c.id !== conversationId,
  );
  // Read now, not before the request went out. Whether this conversation is
  // the one on screen is a question about the moment it disappears, and in
  // between the reader may have picked another row -- deciding at the start
  // would pull them off it. Read before the write below, because that write
  // is what makes the answer unavailable.
  const wasOnScreen = useStore.getState().currentByProject[projectId] === conversationId;

  useStore.setState((s) => {
    const { [conversationId]: _gone, ...conversations } = s.conversations;
    const { [conversationId]: _draft, ...draftByConversation } = s.draftByConversation;
    // The pointer goes with what it pointed at. Left behind it names a
    // conversation that is not there, and everything reading through it --
    // including the gate that allows one turn at a time -- finds nothing and
    // concludes nothing is happening.
    const { [projectId]: _was, ...withoutCurrent } = s.currentByProject;
    return {
      conversations,
      currentByProject: wasOnScreen ? withoutCurrent : s.currentByProject,
      draftByConversation,
      listByProject: { ...s.listByProject, [projectId]: remaining },
    };
  });

  if (!wasOnScreen) return;

  // Landing somewhere else is a navigation like any other, and it has to be
  // ordered against the reader's own: whatever they pressed after this must
  // win over the row this picks for them.
  const nav = intendToNavigate(projectId);
  let landed = false;
  try {

    // The conversation the panel was showing has just gone, and the next one is
    // a round trip away. Saying so is what keeps the empty-conversation greeting
    // off the screen in between -- the panel draws nothing until this says
    // ready, which is the same gate that covers opening. Without it the panel
    // saw "ready, and no messages" and drew a whole screenful of greeting.
    useStore.setState((s) => ({
      openStatus: { ...s.openStatus, [projectId]: 'loading' },
    }));

    const next = remaining[0];
    if (next) {
      // Under the number taken above rather than one of its own: calling
      // `switchTo` would take a second, and the two would then be ordered
      // against each other rather than against what the reader presses next.
      landed = await readAndAdopt(projectId, next.id, nav, true);
      return;
    }
    // None left. `openAndAdopt` rather than `ensureLoaded`, because by that
    // one's reckoning this project is open already and it would return without
    // asking for the conversation that no longer exists.
    const failure = await openAndAdopt(projectId);
    // The scrim, if one is owed, is that call's to raise: it holds the number
    // for the navigation it made, so it is the one that can tell whether the
    // reader is still waiting for it. Raising a second one from here asked
    // nothing at all -- and the branch just above, which lands on the next
    // conversation instead, has always asked first.
    // What is left here is the word about it, and that is owed only while this
    // deletion's landing is still the one being waited for.
    if (failure && stillAwaited(projectId, nav)) {
      tell({ projectId, conversationId: null, deliberate: true, ...readMishap(failure.failed) });
    }
  } finally {
    // However this ended -- landed, failed, or overtaken -- it is over, and
    // being the last one out means nobody else will settle the panel.
    navigationEnded(projectId, nav, landed);
  }
}

/**
 * Hold what is half-typed, under the conversation it was typed in.
 *
 * There is always one to hang it on. For the round trip before a conversation
 * arrives the box is read-only -- the same gate a switch puts it behind -- so
 * nothing can be typed while there is nowhere to put it.
 * @param conversationId - The conversation it was typed in, if one is on screen.
 * @param text - What is in the box.
 */
function setDraft(conversationId: string | undefined, text: string): void {
  if (conversationId === undefined) return;
  useStore.setState((s) => ({
    draftByConversation: { ...s.draftByConversation, [conversationId]: text },
  }));
}

/**
 * Read back what was half-typed.
 * @param conversationId - The conversation asked about, if one is on screen.
 * @returns What is in its box, empty when nothing was left there.
 */
function draftOf(conversationId: string | undefined): string {
  if (conversationId === undefined) return '';
  return useStore.getState().draftByConversation[conversationId] ?? '';
}

/**
 * Forget everything about one project's chat.
 *
 * Called when the user leaves the project. A turn still running is stopped
 * first, because leaving says more plainly than a dropped connection that
 * nobody is listening -- and once the entry is gone there is no screen
 * anywhere showing a stop button for it, so not stopping it would leave the
 * model running on the user's account with the switch out of reach.
 * @param projectId - The project being left.
 */
function leaveProject(projectId: string): void {
  const { conversations } = useStore.getState();
  const leaving = Object.entries(conversations).filter(([, c]) => c.projectId === projectId);

  for (const [id] of leaving) {
    evictChatSession(id);
    // Its pages are on their way to a conversation this visit will not be
    // reading any more. Dropped rather than left to settle, because a press
    // made after coming back would otherwise join one of these instead of
    // making its own -- and these are going to write nothing.
    forgetEarlierPages(id);
  }

  // Raised, not replaced: every request already in flight holds this signal,
  // and it is what stops each of their answers from being written into the
  // next visit. The next `ensureLoaded` starts a fresh visit.
  visits.get(projectId)?.abort();
  visits.delete(projectId);

  useStore.setState((s) => {
    const kept: Record<string, ConversationRuntime> = {};
    for (const [id, conversation] of Object.entries(s.conversations)) {
      if (conversation.projectId !== projectId) kept[id] = conversation;
    }
    const { [projectId]: _current, ...currentByProject } = s.currentByProject;
    const { [projectId]: _status, ...openStatus } = s.openStatus;
    const { [projectId]: _navigating, ...navigatingByProject } = s.navigatingByProject;
    const { [projectId]: _sending, ...sendingByProject } = s.sendingByProject;
    const { [projectId]: _listed, ...listByProject } = s.listByProject;
    const { [projectId]: _more, ...listHasMore } = s.listHasMore;
    const { [projectId]: _moreFailed, ...listMoreFailed } = s.listMoreFailed;
    const { [projectId]: _loadingMore, ...listLoadingMore } = s.listLoadingMore;
    const { [projectId]: _listLoading, ...listLoading } = s.listLoading;
    const { [projectId]: _why, ...openFailure } = s.openFailure;
    // The drafts of every conversation in this project go with it. A draft
    // belongs to a conversation the reader was in, and coming back re-opens
    // the project from the server -- so keeping them would hand a returning
    // reader half a sentence they typed in a session they have left.
    const keptDrafts: Record<string, string> = {};
    for (const [id, draft] of Object.entries(s.draftByConversation)) {
      if (s.conversations[id]?.projectId !== projectId) keptDrafts[id] = draft;
    }
    return {
      conversations: kept,
      currentByProject,
      openStatus,
      navigatingByProject,
      sendingByProject,
      listByProject,
      listHasMore,
      listMoreFailed,
      listLoadingMore,
      listLoading,
      openFailure,
      draftByConversation: keptDrafts,
    };
  });
  opening.delete(projectId);
  // The per-project bookkeeping outside the store goes too. A request for the
  // next page that was in flight has been abandoned with the visit, so leaving
  // this project registered as fetching would make the next visit's first
  // scroll to the end do nothing at all, silently, until that dead request
  // came back on its own.
  fetchingMore.delete(projectId);
  inFlight.delete(projectId);
  claimed.delete(projectId);
  // Nothing is on screen for this project any more, so no number is "what is
  // on screen" either. Kept, it would rank against the next visit's numbers,
  // which come from the same run of `lastIssued` and are all higher anyway --
  // but a stale one is a fact about a project nobody is in.
  lastLanded.delete(projectId);
  // `lastIssued` stays. It is the one of the four that must not restart: a
  // request abandoned with this visit is still out, still holding its number,
  // and still going to run its `finally`. Handing that number out again gives
  // the next visit a navigation the abandoned one will settle -- it reports
  // nothing landed, the panel is left saying it could not be read, and the
  // answer that was on its way arrives to a number nobody is waiting for.
  // Numbers only ever go up, which is what makes "the same number" impossible.
}

/**
 * Forget everything, including requests still in flight.
 *
 * For tests, which share this module across every case in a file the way the
 * app shares it across every panel. Clearing the state alone is not enough:
 * an open request that never settles would still be joined by the next
 * caller, so a case that deliberately leaves one hanging would hang every
 * case after it.
 */
export function _resetForTests(): void {
  opening.clear();
  loadingEarlier.clear();
  visits.clear();
  fetchingMore.clear();
  fetchingList.clear();
  listGeneration.clear();
  inFlight.clear();
  lastIssued.clear();
  claimed.clear();
  lastLanded.clear();
  useStore.setState({
    conversations: {},
    currentByProject: {},
    listByProject: {},
    listHasMore: {},
    listMoreFailed: {},
    listLoadingMore: {},
    listLoading: {},
    openFailure: {},
    draftByConversation: {},
    openStatus: {},
    navigatingByProject: {},
    sendingByProject: {},
  });
}

export const useConversationRuntime = useStore;

export const conversationRuntime = {
  ensureLoaded,
  conversationForSending,
  noteActivity,
  loadEarlier,
  leaveProject,
  switchTo,
  startNew,
  loadMoreConversations,
  reloadConversationList,
  rename,
  remove,
  setDraft,
  draftOf,
};
