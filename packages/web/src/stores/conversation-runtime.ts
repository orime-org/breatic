// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What is happening in each conversation, for as long as the conversation is.
 *
 * A turn used to live in the chat panel: its request, the id of the reply
 * being written, and the flag saying one was in flight were all held in the
 * component, and the cleanup on unmount tore the request down. Collapsing the
 * agent column therefore ended the turn -- the user put a panel away and the
 * answer he was paying for stopped existing.
 *
 * So the turn lives here instead, keyed by the conversation it belongs to. A
 * panel that mounts reads what is going on; a panel that goes away is a panel
 * that went away. What still ends a turn early is what the user did -- pressing
 * stop, or leaving the project -- and one thing they did not: the watchdog
 * ending a stream that has stopped saying it is alive. None of the three is
 * React unmounting a component, which is the whole of the change.
 *
 * Messages live here for the same reason -- a reply being written and the
 * history it is being appended to are one list, and a list only one of whose
 * halves survives the panel is two lists.
 */

import { create } from 'zustand';
import type { MessageData, SSEEventEnvelope } from '@breatic/shared';
import { SSE_EVENT_NAMES, SSE_HEARTBEAT_TIMEOUT_MS, newId } from '@breatic/shared';

import { chatApi } from '@web/data/api/chat';
import { ApiException } from '@web/data/api/types';
import type { ConversationOnTheWire, OpenChatResult } from '@web/data/api/chat';
import {
  StreamRefusedError,
  StreamUnreachableError,
  StreamDroppedError,
} from '@web/data/stream/sse';

/**
 * A message as this store holds it.
 *
 * A stored message minus the turn it belongs to, plus whether its reply is
 * being written right now. The turn index is dropped on the way in because
 * nothing here reads one, and a shape that has the field invites the code
 * that makes a local message up to invent a value for it -- which is what the
 * panel used to do, guessing from the last message it happened to be holding.
 * Where the history reaches back to is a property of the conversation, not of
 * each message, and it is kept as {@link ConversationRuntime.oldestLoadedTurn}.
 *
 * `streaming` is local: the server has no such state. It lasts exactly as long
 * as the message it is on, which is what makes this the right place for it.
 */
export type ChatMessageData = Omit<MessageData, 'turnIndex'> & { streaming?: boolean };

/** The turn a conversation is running, if it is running one. */
interface Turn {
  /** The reply being written, so whatever ends the turn can unmark it. */
  replyId: string;
  /** Raised to stop it. */
  abort: AbortController;
  /**
   * The server has said it stored the message and the turn is under way.
   *
   * False for as long as the request is out and unanswered. What separates the
   * two is not how far along the reply is -- it is whether anything of this
   * turn exists anywhere but in this browser. Before, nothing does: the words
   * are only in the box the reader typed them into, and this end cannot say
   * whether they ever arrived. After, the server has them, has handed the
   * whole conversation back, and is working.
   */
  started: boolean;
}

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
  /** Every message to show, history and the reply in flight alike. */
  messages: ChatMessageData[];
  /**
   * The turn under way.
   *
   * Not null is the whole answer to "is this conversation streaming". It
   * replaces a boolean in one store and two refs in the panel, which said the
   * same thing in three places and had to be kept in step by hand.
   */
  turn: Turn | null;
  /** The server has messages older than the ones loaded. */
  hasMore: boolean;
  /** The oldest turn loaded, which is where loading earlier starts from. */
  oldestLoadedTurn: number | null;
  /**
   * How many turns have failed here.
   *
   * A counter and not a flag, because what a reader needs to know is not
   * "did one fail" -- that is on the message and comes back with the history
   * -- but "did one fail while I was watching". A panel remembers the count
   * it mounted with and announces only what came after.
   */
  failures: number;
  /** The reply of the most recent failure, for the panel to point at. */
  failedReplyId: string | null;
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

/**
 * How far along the send a project has under way, if it has one.
 *
 * The one place this is decided. A turn carries the wait for all but the first
 * moment of one, and a project-level mark carries it before there is a turn --
 * two halves of one fact, so anything asking either question asks here. What
 * reads it: the panel, to know whether to draw a send button, a waiting
 * indicator or a stop button; and `send`, to refuse a second press.
 * @param state - The runtime as it stands.
 * @param projectId - The project asked about.
 * @returns Idle, sending, or running.
 */
export function turnPhaseOf(state: ConversationRuntimeState, projectId: string): TurnPhase {
  const conversationId = state.currentByProject[projectId];
  const turn = conversationId ? state.conversations[conversationId]?.turn : null;
  if (turn) return turn.started ? 'running' : 'sending';
  return state.sendingByProject[projectId] ? 'sending' : 'idle';
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
   * and as the thing that puts the end-of-list watcher back on duty. Nothing
   * about a failed page moves, so the end of the list never crosses back into
   * view on its own; a fresh watcher reports where things stand as it starts,
   * and that is what makes reaching the end count a second time.
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
   * it itself. Absent means nothing came back to say -- the request did not
   * reach anything -- and the scrim falls back to saying so.
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
 * Something that went wrong, told once to whoever is looking.
 *
 * Told, not kept. Every one of these belongs to a moment the reader was in --
 * they pressed send, or a reply they were watching stopped arriving -- and a
 * moment does not wait around. Nobody watching means nobody is in that
 * moment: the panel is collapsed, or they are reading another conversation.
 * What they come back to is a conversation that stopped moving, which is how
 * a reader of a stream knows something went wrong, and it needs no sentence
 * from us repeating it later.
 *
 * The four kinds are not a matter of wording. What tells them apart is what
 * came back: `server` carries the sentence the server wrote for the reader --
 * out of credits, too many requests, not allowed -- `turn` is an answer that
 * came back with none of ours in it, so there is nothing to quote and this
 * end has to supply the words, `network` is no answer at all, and `gone` is
 * our own 404, where the server did answer and what it said is that the
 * conversation is not there any more. That last one is not a failure, which
 * is why it is its own kind rather than a `server` sentence about a resource.
 */
export type ChatMishap = {
  /**
   * The reader did this on purpose and is waiting to hear back.
   *
   * What separates a rename they just pressed from a turn failing in some
   * other conversation in the background. The panel shows only its own
   * conversation's trouble -- except for this, which is theirs whichever
   * conversation it was about.
   */
  deliberate?: boolean;
  /**
   * It is about the list, or about one row in it.
   *
   * The list covers the whole column while it is open, so the panel's own
   * line -- on the top edge of the composer -- is a line nobody can read
   * then. This marks the words as ones the list can carry; whether they
   * actually go there is decided by whether the list is on screen, since the
   * header renames the conversation too and the list is shut for that.
   */
  aboutRow?: boolean;
  /**
   * Which telling this is.
   *
   * Two failures in a row say the same words, and a line that says the same
   * words is a line React leaves alone -- the DOM does not move and a screen
   * reader announces nothing. So the reader presses send a second time, it
   * fails a second time, and nothing whatever happens on screen. This is what
   * makes each telling its own: the panel keys the line by it, so the same
   * sentence is torn down and put up again, which is both visible and spoken.
   */
  at: number;
  /** The project it happened in. */
  projectId: string;
  /** The conversation, or null when there is not one yet to speak of. */
  conversationId: string | null;
} & (
  | { kind: 'network' }
  | { kind: 'server'; message: string }
  // The stream reached us and the server said this turn is over without
  // saying anything a reader could act on. Not `server`: that one carries the
  // sentence the server wrote for the reader, and this one has none -- what
  // comes down the wire here is an English string written for us.
  | { kind: 'turn' }
  // The conversation asked for is not there any more, which our own server
  // said in so many words. Not `server` either: the sentence it sends is
  // about a resource, and this end knows the far more useful thing -- which
  // resource, and that nothing went wrong.
  | { kind: 'gone' }
);

const watchers = new Set<(mishap: ChatMishap) => void>();

/** How many have been told, which is what makes each one its own. */
let told = 0;

/**
 * Be told when something goes wrong, for as long as you are looking.
 * @param watch - Called once per mishap.
 * @returns Call to stop watching.
 */
export function watchChatMishaps(watch: (mishap: ChatMishap) => void): () => void {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

/**
 * Tell whoever is watching. Nobody watching means it is not told.
 * @param mishap - What went wrong.
 */
function tell(mishap: Omit<ChatMishap, 'at'>): void {
  told += 1;
  const withIdentity = { ...mishap, at: told } as ChatMishap;
  for (const watch of watchers) watch(withIdentity);
}

/**
 * The sentence our own server wrote for this reader, if it wrote one.
 *
 * The whole of what this answers. What to say when it answers nothing is not
 * the same question in every place that asks, so it is left to whoever asked.
 * @param err - Whatever the call threw.
 * @returns The server's own words, or nothing when they are not the server's.
 */
function serverSentence(err: unknown): string | undefined {
  // Only a sentence our own server wrote for this reader, whichever transport
  // brought it. An answer coming back is not the same thing: a gateway that
  // timed out also answers, and there is nothing of ours in what it sends --
  // so each transport says whether the message it is carrying came out of our
  // envelope, and this asks both of them the same question and nothing else.
  if (err instanceof StreamRefusedError && err.fromServer) return err.message;
  if (err instanceof ApiException && err.fromServer) return err.message;
  return undefined;
}

/**
 * Read a failed request as the reader would hear it.
 *
 * For the two requests that fetch rather than run a turn: opening the chat,
 * and reaching further back. Either the server wrote a sentence about it or
 * nothing did.
 *
 * A third case exists and is not told apart here: something answered, but
 * with nothing of ours in it. Saying "network error" for that is not right --
 * the network worked -- and there is no sentence yet that fits both of these
 * requests, so one has to be written before this can tell the difference.
 * The turn has one, and {@link readTurnMishap} uses it.
 * @param err - Whatever the call threw.
 * @returns Which kind of mishap it is, and the server's own words when it
 *   answered with any.
 */
function readMishap(err: unknown): { kind: 'network' } | { kind: 'server'; message: string } {
  const said = serverSentence(err);
  return said === undefined ? { kind: 'network' } : { kind: 'server', message: said };
}

/**
 * Read a turn's ending as the reader would hear it.
 *
 * Three endings rather than two, because this is the one path with something
 * true to say about the third. A refusal means the request reached something
 * that answered: the network is not what went wrong, and if what answered was
 * not ours then the only thing left that holds is that this reply is not
 * coming and the words can go again.
 * @param ending - How the turn ended.
 * @returns Which kind of mishap it is, and the server's own words when it
 *   answered with any.
 */
function readTurnMishap(
  ending: unknown,
): { kind: 'network' } | { kind: 'turn' } | { kind: 'server'; message: string } {
  const said = serverSentence(ending);
  if (said !== undefined) return { kind: 'server', message: said };
  if (ending instanceof StreamRefusedError) return { kind: 'turn' };
  return { kind: 'network' };
}

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
 * Rewrite one message of one conversation.
 * @param conversationId - The conversation holding it.
 * @param messageId - The message to rewrite.
 * @param change - Applied to it, returning the replacement.
 */
function patchMessage(
  conversationId: string,
  messageId: string,
  change: (m: ChatMessageData) => ChatMessageData,
): void {
  patchConversation(conversationId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? change(m) : m)),
  }));
}

/**
 * Drop the turn index off a stored message.
 * @param message - The message as the server hands it out.
 * @returns The same message in this store's shape.
 */
function toStored(message: MessageData): ChatMessageData {
  const { turnIndex: _turnIndex, ...rest } = message;
  return rest;
}

/**
 * The oldest turn among a batch of stored messages.
 * @param messages - The batch, as the server hands it out.
 * @returns That turn, or null when the batch is empty.
 */
function oldestTurnOf(messages: readonly MessageData[]): number | null {
  return messages.length > 0 ? Math.min(...messages.map((m) => m.turnIndex)) : null;
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
 * one of the two callers is a send that is going to try again and a line
 * about a failure that healed itself is a line about nothing.
 *
 * Written once because both callers owe the reader the same things -- the
 * same status while it runs, the same check that the visit which asked is
 * still the one on screen. The second caller is the turn that finds its
 * conversation gone; having its own copy of this was how one of them came to
 * leave the status saying `loading` for ever.
 * @param projectId - The project whose chat to open.
 * @returns What went wrong, or nothing when there is a conversation on screen
 *   -- and nothing as well when the visit that asked is over, which is not a
 *   failure anyone is owed a word about.
 */
async function openAndAdopt(projectId: string): Promise<OpenFailure | undefined> {
  const nav = intendToNavigate(projectId);
  let landed = false;
  // Taken here rather than inside, because the clean-up below has to ask
  // whether this is still the visit that asked -- and asking again down there
  // would answer about whichever visit is current by then.
  const visit = currentVisit(projectId);
  firstPageStarted(projectId);
  beganListRead(projectId);
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
      const wrote = wroteSince(projectId);
      useStore.setState((st) => {
        const held = st.listByProject[projectId] ?? [];
        const standing = reconcile(opened.conversations, wrote);
        // Rows written while this was out go first: the list is ordered by when
        // each conversation was last used, and those are the most recent thing
        // that happened here.
        const listed = landed
          ? standing
          : [...held, ...standing.filter((c) => !held.some((h) => h.id === c.id))];
        return {
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
    // Not if the visit that asked is over: this project's bookkeeping belongs
    // to whoever is here now, and an abandoned request must not settle it.
    firstPageEnded(projectId);
    endedListRead(projectId);
    if (!visit.signal.aborted) settleListLoading(projectId);
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
  // The answer carries the name as it is now, and the list carries it as it
  // was when the list was fetched. Another tab renaming it in between is
  // exactly the case where those differ -- and this one was read a moment ago,
  // so it wins. Dropping it left the header and the row showing a name that no
  // longer exists, with nothing the reader could do about it.
  applyTitle(projectId, conversationId, opened.conversation.title ?? null);
  useStore.setState((s) => {
    const held = s.conversations[conversationId];
    // The one thing this answer does NOT describe: a turn still running here.
    // A reply is written to the database when the turn ends, so a turn under
    // way is not a state the server has contradicted -- it is one the server
    // has not written down yet. Dropping it took the reply off the screen,
    // took the stop button with it, and left the request with nothing holding
    // its abort handle: the model went on running, and on billing, with the
    // switch out of reach.
    const running = held?.turn ?? null;
    const reply = running
      ? held?.messages.find((m) => m.id === running.replyId)
      : undefined;
    const page = opened.messages.map(toStored);

    return {
      openStatus: { ...s.openStatus, [projectId]: 'ready' },
      // Whatever went wrong last time is over. A reason kept past it would
      // be shown as the reason for whatever goes wrong next.
      openFailure: (({ [projectId]: _gone, ...rest }) => rest)(s.openFailure),
      currentByProject: { ...s.currentByProject, [projectId]: conversationId },
      conversations: {
        ...s.conversations,
        [conversationId]: {
          projectId,
          // The reply being written goes back on the end, where it was. It is
          // not in the page: the server cannot hand back something it has not
          // stored.
          messages: reply ? [...page, reply] : page,
          turn: running,
          hasMore: opened.hasMore,
          oldestLoadedTurn: oldestTurnOf(opened.messages),
          // Carried over, unlike everything above it. What the server has just
          // described is the conversation; how many of its turns failed while
          // this reader was sitting here is not something it knows or is
          // saying anything about. Restarting it at zero under a panel holding
          // a baseline from before would make the next failure read as older
          // than the one it is compared against, and go unannounced.
          failures: held?.failures ?? 0,
          failedReplyId: held?.failedReplyId ?? null,
          title: opened.conversation.title ?? null,
        },
      },
    };
  });
}

/**
 * End the turn a conversation is running.
 *
 * Everything that ends a turn comes through here -- the server saying so, an
 * error, the user pressing stop, the connection going quiet -- so no path can
 * clear one mark and forget the other.
 * @param conversationId - The conversation whose turn ended.
 * @param replyId - The reply this ending belongs to. An ending arriving for a
 *   turn that is no longer the one running belongs to nothing: the server
 *   finishes a failed turn by sending `error` and only then writing it down,
 *   and the next turn can already be under way by then.
 */
function finishTurn(conversationId: string, replyId: string): void {
  patchConversation(conversationId, (c) => {
    if (c.turn?.replyId !== replyId) return c;
    return {
      ...c,
      turn: null,
      messages: c.messages.map((m) => {
        if (m.id !== replyId) return m;
        const { streaming: _streaming, ...rest } = m;
        return rest;
      }),
    };
  });
}

/**
 * Stop the turn a conversation is running, if it is running one.
 *
 * The ending that means the reply was cut off, so it is marked as such
 * before the turn is forgotten -- leaving it out makes the identical message
 * read as a finished answer now and as a stopped one after a reload.
 *
 * The mark says what this end of the wire knows, and no more. When the user
 * pressed stop or left the project, the server saw the client go and recorded
 * the same thing. When a connection died instead, what the server has depends
 * on what happened to it, and this end cannot tell which: a path that broke
 * silently leaves the server finishing the turn and storing the whole reply
 * unmarked, while a server that went away stored nothing at all -- not even
 * the part that had already arrived here.
 *
 * The mark is put on anyway, and what it renders is one word: "Stopped". That
 * is the honest cost of this, written down rather than argued away -- on the
 * silent-break path the server may hold a finished reply with no such mark,
 * so a reload can make the word disappear. The alternative is worse: a reply
 * that stops mid-sentence with nothing at all said about it.
 *
 * A turn the server has not answered yet has no reply on screen to mark, and
 * marking it is skipped rather than special-cased: there is no message with
 * that id, so the rewrite finds nothing to rewrite. That is the right outcome
 * too -- nothing of that turn was ever shown, so nothing is left half-said.
 * @param conversationId - The conversation to stop.
 */
function stopTurn(conversationId: string): void {
  const turn = useStore.getState().conversations[conversationId]?.turn;
  if (!turn) return;
  patchMessage(conversationId, turn.replyId, (m) => ({ ...m, interrupted: true as const }));
  turn.abort.abort();
  finishTurn(conversationId, turn.replyId);
}

/**
 * Is this event still about the turn that is running.
 *
 * An ending can arrive after the turn it belongs to is over: the server
 * finishes a failed turn by sending `error` and only then writing it down, and
 * the next turn can already be under way. Acting on one then would mark, end
 * or take the screen over on behalf of something nobody is waiting for.
 *
 * What asks this: the watchdog, the stream's error handler, and the `error`
 * frame. The server's own ending -- `chat_done` -- does not, because what it
 * reaches are two writes that carry the same question inside them: marking a
 * message finds it by id, and `finishTurn` compares the running reply against
 * the one it was given.
 * @param conversationId - The conversation the event arrived for.
 * @param replyId - The reply the event belongs to.
 * @returns The conversation when it is still running that turn.
 */
function stillRunning(
  conversationId: string,
  replyId: string,
): (ConversationRuntime & { turn: Turn }) | undefined {
  const conversation = useStore.getState().conversations[conversationId];
  if (!conversation || conversation.turn?.replyId !== replyId) return undefined;
  return { ...conversation, turn: conversation.turn };
}

/**
 * Everything one turn does to the store while it runs.
 * @param conversationId - The conversation it runs in.
 * @param replyId - The reply it is writing.
 * @param event - One event off the stream.
 */
function applyEvent(conversationId: string, replyId: string, event: SSEEventEnvelope): void {
  switch (event.event) {
    // The server saying what it holds, at the one moment it can be sure the
    // reader is waiting: they pressed send, so a list changing under them
    // reads as their message arriving rather than as the screen jumping.
    //
    // Taken whole, because that is the point of it -- a browser that kept
    // any of its own version would be keeping exactly the part that might be
    // wrong. Everything except the reply being written: that one has not been
    // stored yet, so the server could not have sent it, and it is the only
    // thing here the server does not know better than we do.
    case SSE_EVENT_NAMES.CHAT_TURN_STARTED: {
      const settled = (event.data.messages ?? []) as MessageData[];
      // Read, decide, then write. A conversation is rebuilt by a pure function
      // of what it held, and this has to reach into another store; doing it
      // inside that function would be changing the world from inside the
      // description of a change.
      const running = stillRunning(conversationId, replyId);
      if (!running) break;
      const started = running.turn;

      // The words are in the conversation now, so the box no longer has to
      // hold them. Emptied whatever is in it, because only one thing can be:
      // the box takes nothing between the press and this event, so there is
      // no sentence of the reader's own in there to take away. Three rules
      // were tried for telling their letters from ours before it was clear
      // that the question only exists if the box accepts input while it is
      // showing something it did not get from them.
      //
      // This conversation's box, and no other. Another conversation may be
      // holding a sentence its reader has not sent, and this turn landing
      // here says nothing about that one.
      setDraft(conversationId, '');

      // The name arrives on this event because this turn may be the one that
      // gave the conversation its name -- the first message in a conversation
      // names it. Written whatever it says, including null: a conversation
      // that has still not been named is a fact the list needs as much as a
      // name is.
      if ('title' in event.data) {
        noteActivity(running.projectId, conversationId, event.data.title as string | null);
      }

      patchConversation(conversationId, (c) => {
        // The place the reply will be written into, made here because this is
        // the moment there is a reply to expect. Empty, and marked as being
        // written, so the bubble can show the turn is under way before the
        // first word of it arrives.
        const reply: ChatMessageData = {
          id: replyId,
          role: 'assistant',
          parts: [],
          content: '',
          ts: new Date().toISOString(),
          streaming: true,
        };
        return {
          ...c,
          messages: [...settled.map(toStored), reply],
          turn: { ...started, started: true },
          hasMore: Boolean(event.data.hasMore),
          // The list was replaced, so anything the reader had pulled up from
          // further back went with it. Saying otherwise would send the next
          // press asking from a turn no longer on screen, leaving a gap.
          oldestLoadedTurn: oldestTurnOf(settled) ?? c.oldestLoadedTurn,
        };
      });
      break;
    }

    case SSE_EVENT_NAMES.CHAT_CHUNK:
      patchMessage(conversationId, replyId, (m) => ({
        ...m,
        content: m.content + String(event.data.text ?? ''),
      }));
      break;

    case SSE_EVENT_NAMES.AGENT_THINKING:
      patchMessage(conversationId, replyId, (m) => ({
        ...m,
        thinking: (m.thinking ?? '') + String(event.data.text ?? ''),
      }));
      break;

    case SSE_EVENT_NAMES.CHAT_DONE:
      if (event.data.aborted) {
        patchMessage(conversationId, replyId, (m) => ({ ...m, interrupted: true as const }));
      }
      finishTurn(conversationId, replyId);
      break;

    case SSE_EVENT_NAMES.ERROR: {
      const failing = stillRunning(conversationId, replyId);
      if (!failing) break;
      // What the server says here is a hardcoded English sentence; the panel
      // shows its own wording, so only the fact matters.
      patchMessage(conversationId, replyId, (m) => ({ ...m, failed: true }));
      patchConversation(conversationId, (c) => ({
        ...c,
        failures: c.failures + 1,
        failedReplyId: replyId,
      }));
      // Only when there is no bubble to say it. A turn can fail before the
      // reply exists -- while the server is still storing the message and
      // reading the conversation back -- and then the marks above land on
      // nothing and the reader sees the waiting stop and nothing else happen.
      // Once the bubble is there it says the same sentence itself, and saying
      // it twice is two alerts for one failure.
      if (!failing.messages.some((m) => m.id === replyId)) {
        tell({ projectId: failing.projectId, conversationId, kind: 'turn' });
      }
      finishTurn(conversationId, replyId);
      break;
    }

    // The stream saying it is alive. Its arrival is the whole message, and
    // the watchdog that resets on it is set up where the turn is run.
    case SSE_EVENT_NAMES.HEARTBEAT:
      break;

    // Raised as the model reaches for a tool, and as it hands back something
    // for the panel to draw. Rendering those is PR-6; they are named here so
    // a new event is a missing case rather than something silently ignored.
    case SSE_EVENT_NAMES.AGENT_TOOL_HINT:
    case SSE_EVENT_NAMES.AGENT_ASK:
    case SSE_EVENT_NAMES.AGENT_CHOICE:
    case SSE_EVENT_NAMES.AGENT_CANVAS_ACTION:
    case SSE_EVENT_NAMES.AGENT_SEARCH_RESULTS:
      break;
  }
}

/** What ended a turn, when what ended it means the turn never ran. */
type NeverRan = StreamRefusedError | StreamUnreachableError;

/**
 * Run one turn against one conversation.
 * @param projectId - The project it belongs to.
 * @param conversationId - The conversation to write it to.
 * @param said - What was in the composer, as it stood there. Sent trimmed;
 *   nothing here writes to the box, either way this ends.
 * @returns The refusal that ended it, when one did.
 */
async function runTurn(
  projectId: string,
  conversationId: string,
  said: string,
): Promise<NeverRan | undefined> {
  const text = said.trim();
  // `newId` and not `crypto.randomUUID`: same v4 shape, but it is the
  // generator the rest of the app uses, and it works outside a secure context
  // where `crypto.randomUUID` is undefined.
  const replyId = `local-reply-${newId()}`;

  // Nothing is written to the list here -- not the question, not a place for
  // the reply. Both used to be, and both were the browser saying something it
  // could not know: that the words got through, and that an answer to them is
  // coming. Neither survives a server that refuses the turn, and putting them
  // up meant taking them down again, which is a screen that changes its mind
  // in front of the reader. The turn's first event says what is stored, and
  // that is when this turn appears.
  const abort = new AbortController();
  patchConversation(conversationId, (c) => ({
    ...c,
    turn: { replyId, abort, started: false },
    // Whatever failed before this is no longer what is happening: it has
    // become part of the history, and the failure worth announcing from here
    // on is this turn's, if it has one.
    failedReplyId: null,
  }));

  // The stream says it is alive on a schedule of the server's, and this is
  // what listens for it. A connection that dies without closing produces no
  // error and no close -- the socket simply never says anything again -- so
  // without this the turn would wait for a reply that is never coming, with
  // no way to send anything for as long as it lasted. Missing beats end the turn the same
  // way pressing stop does, because from here the two are the same fact:
  // nothing more is coming.
  // Armed before the request goes out, so the wait it measures starts at the
  // press: a connection that never opens is exactly the case nothing else
  // reports, and the budget has to cover it. The cost of that choice is that
  // setting the connection up spends the same budget, so a network slow enough
  // to take fifteen seconds getting a socket open ends the turn.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Start the wait for the next beat over, whatever just arrived. */
  const expectAnotherBeat = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      // Only the turn it was set for. A turn ends when the server says so,
      // which is a moment before the socket closes and this is cleared -- and
      // the composer is live for the whole of that gap, so the next turn can
      // already be under way. A watchdog that stopped "whatever is running"
      // would kill it on behalf of a turn that finished perfectly well.
      if (!stillRunning(conversationId, replyId)) return;
      stopTurn(conversationId);
      // Ended the same way pressing stop does, but the reader did not press
      // anything, so unlike stop this one is worth a word.
      tell({ projectId, conversationId, kind: 'network' });
    }, SSE_HEARTBEAT_TIMEOUT_MS);
  };
  expectAnotherBeat();

  let neverRan: NeverRan | undefined;

  await chatApi.streamMessage(
    { projectId, conversationId, message: text },
    {
      signal: abort.signal,
      onEvent: (event) => {
        expectAnotherBeat();
        applyEvent(conversationId, replyId, event);
      },
      onClose: () => finishTurn(conversationId, replyId),
      onError: (err: unknown) => {
        // Two endings, and which one it is decides who says so.
        if (err instanceof StreamRefusedError || err instanceof StreamUnreachableError) {
          // The server answered and said no, or the request never left. Either
          // way the turn never ran and the words are still in the box -- and
          // whether that is worth a word depends on what the caller does next,
          // because one of the two refusals is worth trying again. Handed over
          // rather than announced here: a line about a failure that healed
          // itself is a line about nothing, and this end cannot tell which it
          // is going to be.
          neverRan = err;
        } else if (stillRunning(conversationId, replyId) !== undefined) {
          // The stream opened and then died. Nothing follows this -- there is
          // no attempt to wait on and nobody to hand it to -- so it is said
          // here, by the only ending that knows it is the last one.
          //
          // Guarded on this still being the turn that is running: an error
          // arriving late belongs to a turn that already ended, and acting on
          // it would mark or announce it over the turn that came after.
          if (err instanceof StreamDroppedError) {
            // The server sees this as the client going away and cannot tell it
            // from the user pressing stop, so it records the turn as stopped
            // and this says the same.
            patchMessage(conversationId, replyId, (m) => ({ ...m, interrupted: true as const }));
          }
          tell({ projectId, conversationId, ...readTurnMishap(err) });
        }
        finishTurn(conversationId, replyId);
      },
    },
  );

  clearTimeout(watchdog);
  return neverRan;
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
 * Is this ending one a second attempt could get past.
 *
 * A conversation can be deleted from another tab while this one still holds
 * its id, and that is not something the reader did or can act on -- so the
 * send opens a replacement and puts the same words on it, and neither the
 * refusal nor the recovery is worth a word. Every other refusal says trying
 * again is pointless, and is told.
 *
 * Note what this does not say: that a second attempt will work. The same 404
 * comes back from a project that is gone or that the reader has been taken
 * off, and then opening a replacement asks the same question of the same
 * project. Whoever tries is the one who finds out, which is why they are also
 * the one who speaks.
 *
 * The status alone is not enough to ask this of. A proxy answering 404 for a
 * path it does not know sends the same number as our own "that conversation
 * is gone", and acting on it opens a conversation and puts the reader's words
 * on it over an answer no part of our server produced. So the refusal has to
 * be one of ours before any of that is worth doing.
 * @param ending - How the turn ended.
 * @returns True when a replacement conversation is worth opening.
 */
function worthASecondAttempt(ending: unknown): boolean {
  return (
    ending instanceof StreamRefusedError && ending.fromServer && ending.status === NOT_FOUND
  );
}

/**
 * Say one thing in a project's chat and stream the reply into it.
 *
 * Opens a conversation first when there is not one. Pressing send is the whole
 * of what a reader has to do here: a chat that could not be opened when the
 * project came up leaves nothing for them to fix and nothing to press twice,
 * and the box they typed into stays exactly as they left it either way.
 *
 * Never rejects. Everything that can go wrong here is told to whoever is
 * looking, once, at the moment it happens -- and nothing else on the screen
 * moves, because nothing about it has changed.
 * @param projectId - The project whose chat this is.
 * @param said - What was in the composer, as it stood there.
 */
async function send(projectId: string, said: string): Promise<void> {
  if (said.trim().length === 0) return;
  // One send at a time in a project. Two presses in the gap before a turn
  // exists land as two turns: the same sentence stored twice, the model asked
  // twice, both charged for, and the first turn overwritten by the second so
  // nothing on screen can stop it.
  if (turnPhaseOf(useStore.getState(), projectId) !== 'idle') return;
  // The conversation this would be written into is the one on screen, and a
  // navigation in flight is on its way to replace it. Sending now writes into
  // the one being left: the words and the reply that follows both vanish when
  // the switch lands, while that turn goes on running and being charged for,
  // with no stop button anywhere -- the panel by then is reading the turn of
  // the conversation the reader arrived in.
  // Only when there is one on screen. A send with no conversation yet is a
  // different thing, and `sendOnce` opens one and waits for it.
  const state = useStore.getState();
  if (state.currentByProject[projectId] !== undefined && navigationInFlight(projectId)) return;
  await sendOnce(projectId, said);
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
 * Open a conversation if there is not one, then run the turn in it.
 * @param projectId - The project whose chat this is.
 * @param said - What was in the composer, as it stood there.
 */
async function sendOnce(projectId: string, said: string): Promise<void> {
  // Held from the start, not read again later. Leaving the project raises
  // this one and forgets it, so asking for the visit afterwards would hand
  // back a fresh, unraised signal -- and every line below would be spoken to
  // the visit the reader is on now about the one they walked out of.
  const visit = currentVisit(projectId);
  /**
   * Say this, unless the reader has walked out of the project since.
   * @param mishap - Which conversation it is about, and what to say.
   */
  const tellThisVisit = (mishap: Omit<ChatMishap, 'at' | 'projectId'>): void => {
    if (visit.signal.aborted) return;
    tell({ projectId, ...mishap });
  };

  if (useStore.getState().currentByProject[projectId] === undefined) {
    await whileOpening(projectId, () => ensureLoaded(projectId));
  }
  const conversationId = useStore.getState().currentByProject[projectId];
  // Opening said why it could not, to everyone who was looking. There is
  // nothing to add and nothing to undo: no turn was started, and the words are
  // where the reader left them.
  if (!conversationId) return;

  const ending = await runTurn(projectId, conversationId, said);
  if (!ending) return;

  // The turn hands back every ending it could not be the last word on, and
  // this is where the last word is decided -- so every path out of here that
  // stops trying says so exactly once.
  if (!worthASecondAttempt(ending)) {
    tellThisVisit({ conversationId, ...readTurnMishap(ending) });
    return;
  }

  // Not `ensureLoaded`: by its reckoning this project is open already. What
  // is needed is a new one, because the one on screen is the one the server
  // just said it does not have.
  const { answer: reopen } = await whileOpening(projectId, () =>
    joinOrStart(opening, projectId, () => openAndAdopt(projectId)),
  );
  const fresh = useStore.getState().currentByProject[projectId];
  // Compared against the one that was refused, not just checked for being
  // there: a failed open leaves the old id in place, and running the turn
  // against it again would send the same words to the conversation the server
  // has just said it does not have -- refused again, re-opened again.
  if (!fresh || fresh === conversationId) {
    // What is quoted is the newer of the two answers when there is one: a
    // reader whose access was taken away mid-send is owed that, not the
    // sentence about the conversation the first attempt went looking for.
    tellThisVisit({
      conversationId: null,
      ...readTurnMishap(reopen ? reopen.failed : ending),
    });
    return;
  }

  // A plain turn, not a resumed one: the first attempt never put anything on
  // screen, and adopting the new conversation replaced the list besides.
  // Nothing of the attempt is left to reuse, so the words go on again with the
  // turn that is re-sending them.
  //
  // Once, not until it works. A second refusal is the answer, not an invitation
  // to open a third conversation -- and it is this end of the line, so it is
  // said rather than handed on to nobody.
  const retry = await runTurn(projectId, fresh, said);
  if (retry) tellThisVisit({ conversationId: fresh, ...readTurnMishap(retry) });
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
        messages: [...earlier.messages.map(toStored), ...c.messages],
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
 * what the reader actually chose. That question goes to {@link lastIssued},
 * which never forgets.
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
 * Whether anything is on its way to change which conversation is on screen.
 *
 * Asked by whoever is about to act on the conversation that is on screen now:
 * one in flight means that conversation is about to stop being the answer.
 * @param projectId - The project being asked about.
 * @returns Whether a navigation is out for it.
 */
function navigationInFlight(projectId: string): boolean {
  const flying = inFlight.get(projectId);
  return flying !== undefined && flying.size > 0;
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
  if (!landed && claimed.get(projectId) === token) {
    // This press asked for nothing in the end, so it stops outranking the
    // others. Whatever is still travelling is the reader's wish again -- the
    // newest of those, since the older ones were already overtaken.
    const stillGoing = flying === undefined || flying.size === 0 ? undefined : Math.max(...flying);
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
  const awaited = claimed.get(projectId);
  if (awaited === undefined || flying === undefined || !flying.has(awaited)) {
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
  noteNamedDuringFetch(projectId, conversationId, title);
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
 * time, which the row shows and which the server will not tell us about again
 * until the project is re-opened. And the order, because the list is sorted
 * most recently used first and that is the order `remove` reads to pick where
 * to land -- a list that never re-sorts makes both of those wrong the moment
 * the reader speaks in anything but the top one.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation just spoken in.
 * @param title - What it is called now, or null if it still has no name.
 */
function noteActivity(projectId: string, conversationId: string, title: string | null): void {
  noteNamedDuringFetch(projectId, conversationId, title);
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
 * What a conversation is called, as the header should say it.
 * @param conversationId - The conversation asked about.
 * @returns Its name, or null when it has none or is not held.
 */
function titleOf(conversationId: string): string | null {
  return useStore.getState().conversations[conversationId]?.title ?? null;
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
      noteMadeDuringFetch(projectId, created.id);
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
      tell({ projectId, conversationId: null, deliberate: true, ...readMishap(err) });
      // This press asked for nothing in the end. Whatever it overtook -- an
      // opening still on its way, a delete looking for somewhere to land -- is
      // the reader's choice again, so the claim goes back before anything else
      // is decided.
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
 * and every one of those would ask for the same page again -- the answers
 * would arrive one after another and each would be appended, so the same rows
 * would appear two and three times over.
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
 * What the reader did to a project's list while a request for it was out.
 *
 * Any answer describes the server as it was when its request left, and it
 * cannot know about anything done since. Which of its rows still belong, what
 * they are called, and which rows of ours it does not mention, is a question
 * about *what happened* -- not about how the list looked at two moments.
 * Comparing two snapshots loses exactly the cases that matter: a conversation
 * made and then deleted is absent at both ends, a rename moves no id, and a
 * page that arrived meanwhile looks the same as something newly made.
 *
 * One record per project, shared by every request out for that list at once,
 * because they all have the same question to ask of it.
 */
interface ListWrites {
  /** Conversations deleted since the request left. */
  deleted: Set<string>;
  /** Conversations started since, in the order they were started. */
  made: string[];
  /** Names written since, by conversation. */
  named: Map<string, string | null>;
}

const wroteWhileFetching = new Map<string, ListWrites>();

/** How many requests for a project's list are out, record-keeping aside. */
const listReadsOut = new Map<string, number>();

/**
 * Start keeping a record of what the reader does while a list request is out.
 * @param projectId - The project being read.
 */
function beganListRead(projectId: string): void {
  const out = (listReadsOut.get(projectId) ?? 0) + 1;
  listReadsOut.set(projectId, out);
  if (out === 1) {
    wroteWhileFetching.set(projectId, { deleted: new Set(), made: [], named: new Map() });
  }
}

/**
 * Stop keeping it, once the last request out has landed.
 * @param projectId - The project being read.
 */
function endedListRead(projectId: string): void {
  const left = (listReadsOut.get(projectId) ?? 1) - 1;
  if (left > 0) {
    listReadsOut.set(projectId, left);
    return;
  }
  listReadsOut.delete(projectId);
  wroteWhileFetching.delete(projectId);
}

/**
 * What the reader did while this request was out.
 * @param projectId - The project being read.
 * @returns The record, empty when nothing was kept.
 */
function wroteSince(projectId: string): ListWrites {
  return (
    wroteWhileFetching.get(projectId) ?? { deleted: new Set(), made: [], named: new Map() }
  );
}

/**
 * Take an answer about a list and put back what happened while it was out.
 * @param answered - The rows the server named.
 * @param wrote - What the reader did meanwhile.
 * @returns The rows still standing, under the names they have now.
 */
function reconcile<T extends { id: string; title: string | null }>(
  answered: readonly T[],
  wrote: ListWrites,
): T[] {
  return answered
    .filter((c) => !wrote.deleted.has(c.id))
    .map((c) => (wrote.named.has(c.id) ? { ...c, title: wrote.named.get(c.id) ?? null } : c));
}

/**
 * Note that a conversation was deleted, in case a first page is out.
 * @param projectId - The project it was in.
 * @param conversationId - The conversation deleted.
 */
function noteDeletedDuringFetch(projectId: string, conversationId: string): void {
  const wrote = wroteWhileFetching.get(projectId);
  if (!wrote) return;
  wrote.deleted.add(conversationId);
  const madeAt = wrote.made.indexOf(conversationId);
  if (madeAt >= 0) wrote.made.splice(madeAt, 1);
}

/**
 * Note that a conversation was started, in case a first page is out.
 * @param projectId - The project it is in.
 * @param conversationId - The conversation started.
 */
function noteMadeDuringFetch(projectId: string, conversationId: string): void {
  const wrote = wroteWhileFetching.get(projectId);
  if (!wrote) return;
  wrote.made.push(conversationId);
}

/**
 * Note that a conversation was named, in case a first page is out.
 * @param projectId - The project it is in.
 * @param conversationId - The conversation named.
 * @param title - What it is called now, or null if it still has none.
 */
function noteNamedDuringFetch(
  projectId: string,
  conversationId: string,
  title: string | null,
): void {
  wroteWhileFetching.get(projectId)?.named.set(conversationId, title);
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
  fetchingMore.add(projectId);
  beganListRead(projectId);
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
    const wrote = wroteSince(projectId);
    useStore.setState((s) => {
      const current = s.listByProject[projectId] ?? [];
      // The page starts after the last row held, so in an order that has not
      // moved these are all new. It can move, though -- another tab, or this
      // one, may have written a row in the meantime -- and a list is one row
      // per conversation whatever happened in between.
      const known = new Set(current.map((c) => c.id));
      const fresh = reconcile(page.conversations, wrote).filter((c) => !known.has(c.id));
      return {
        listByProject: { ...s.listByProject, [projectId]: [...current, ...fresh] },
        listHasMore: { ...s.listHasMore, [projectId]: page.hasMore },
      };
    });
  } catch (err) {
    if (visit.signal.aborted) return;
    useStore.setState((st) => ({
      listMoreFailed: { ...st.listMoreFailed, [projectId]: true },
    }));
    // The reader reached the end themselves, so this is an answer to something
    // they did.
    tell({ projectId, conversationId: null, deliberate: true, ...readMishap(err) });
  } finally {
    // Only if this is still the visit that asked. The bookkeeping is kept per
    // project, and a request abandoned with a visit lands whenever it lands --
    // by then the reader may have come back and asked again. Clearing then
    // takes down the line saying a page is on its way while one still is, and
    // opens the gate that stops the same page being asked for twice.
    endedListRead(projectId);
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
  beganListRead(projectId);
  useStore.setState((st) => ({ listLoading: { ...st.listLoading, [projectId]: true as const } }));
  try {
    const page = await chatApi.listConversations(projectId, undefined, visit.signal);
    if (visit.signal.aborted) return;
    const wrote = wroteSince(projectId);
    useStore.setState((st) => {
      const held = st.listByProject[projectId] ?? [];
      const standing = reconcile(page.conversations, wrote);
      const answeredIds = new Set(standing.map((c) => c.id));
      // Made while this was out and not in the answer either -- the server had
      // not heard about those when it replied. In the order they were made,
      // and first, because that is the most recent thing that happened here.
      const made = wrote.made
        .filter((id) => !answeredIds.has(id))
        .map((id) => held.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      return {
        listByProject: { ...st.listByProject, [projectId]: [...made, ...standing] },
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
    // The count pairs on every exit; only the flag the panel renders belongs
    // to whoever is here now.
    firstPageEnded(projectId);
    endedListRead(projectId);
    if (!visit.signal.aborted) settleListLoading(projectId);
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
  // conversation that no longer exists.
  stopTurn(conversationId);
  noteDeletedDuringFetch(projectId, conversationId);

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
    stopTurn(id);
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
  // `lastIssued` stays. It is the one of the three that must not restart: a
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
  listReadsOut.clear();
  wroteWhileFetching.clear();
  inFlight.clear();
  lastIssued.clear();
  claimed.clear();
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
  send,
  stopTurn,
  loadEarlier,
  leaveProject,
  switchTo,
  startNew,
  loadMoreConversations,
  reloadConversationList,
  titleOf,
  rename,
  remove,
  setDraft,
  draftOf,
};
