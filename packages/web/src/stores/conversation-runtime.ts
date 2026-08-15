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
 * The three kinds are not a matter of wording. What tells them apart is
 * whether a sentence of ours came back: `server` carries the one the server
 * wrote for the reader -- out of credits, too many requests, not allowed --
 * `turn` is an answer that came back with none of ours in it, so there is
 * nothing to quote and this end has to supply the words, and `network` is no
 * answer at all.
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
  draftByConversation: {},
  openStatus: {},
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
  const visit = currentVisit(projectId);
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
    // Overtaken, and that settles the list as much as the conversation. This
    // answer was assembled before whatever the reader did next, so the list in
    // it does not have their new conversation -- writing it would leave them
    // inside a conversation the history sheet cannot show, with no way back to
    // it once they navigate away.
    if (!stillAwaited(projectId, nav)) return undefined;
    adoptConversation(projectId, opened.current);
    // The list arrives with the same answer and used to be dropped here, which
    // is why the history sheet had nothing to show even once it could be
    // opened at all.
    useStore.setState((st) => ({
      listByProject: { ...st.listByProject, [projectId]: opened.conversations },
      listHasMore: { ...st.listHasMore, [projectId]: opened.hasMoreConversations },
    }));
    return undefined;
  } catch (err) {
    // Except when the visit that asked is over, which includes this refusal
    // being the abort itself. Reporting it then would have the caller replace
    // a conversation the reader is looking at now with the news that a
    // request they walked away from did not work.
    if (visit.signal.aborted) return undefined;
    // Not over a chat that has opened before. There is a conversation on
    // screen and it is still readable; saying it could not be opened would
    // take it away over a request the reader did not make.
    useStore.setState((s) =>
      s.openStatus[projectId] === 'ready'
        ? s
        : { openStatus: { ...s.openStatus, [projectId]: 'failed' } },
    );
    return { failed: err };
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

    // Anything typed while this was loading was kept under the project,
    // because there was no conversation to keep it under. There is now.
    const waiting = s.draftByConversation[projectDraftKey(projectId)];
    const drafts = { ...s.draftByConversation };
    if (waiting !== undefined) {
      delete drafts[projectDraftKey(projectId)];
      // Only into an empty box: a conversation being re-read may already hold
      // a sentence of its own, and that one was typed in it.
      if (!drafts[conversationId]) drafts[conversationId] = waiting;
    }

    return {
      draftByConversation: drafts,
      openStatus: { ...s.openStatus, [projectId]: 'ready' },
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
      setDraft(running.projectId, conversationId, '');

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
    tell({ projectId, ...mishap } as Omit<ChatMishap, 'at'>);
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
 * How many times each project's reader has asked to be somewhere.
 *
 * Outside the state because nothing renders it: it exists so an answer can ask
 * "is the reader still waiting for me" before it puts a conversation on
 * screen. Every route that writes `currentByProject` takes a number before it
 * asks for anything and checks it before it writes -- a switch, a new
 * conversation, and the first open all land here, and any of them can be
 * overtaken by a later press.
 *
 * A count rather than the conversation being waited for, because one of those
 * routes does not know what it is landing on until the server answers: a new
 * conversation has no id until it has been created.
 */
const navigations = new Map<string, number>();

/**
 * Record that the reader has asked to be somewhere in this project.
 * @param projectId - The project being navigated.
 * @returns The number to check back with before landing.
 */
function intendToNavigate(projectId: string): number {
  const next = (navigations.get(projectId) ?? 0) + 1;
  navigations.set(projectId, next);
  return next;
}

/**
 * Whether the reader is still waiting for the navigation with this number.
 * @param projectId - The project.
 * @param token - What {@link intendToNavigate} handed back.
 * @returns True while nothing later has been asked for.
 */
function stillAwaited(projectId: string, token: number): boolean {
  return navigations.get(projectId) === token;
}

/**
 * End a navigation that failed with nobody behind it to finish the job.
 *
 * Saying `loading` is a promise that a conversation is coming, and whoever
 * says it has to see it through to one of the two ends: a conversation on
 * screen, or a scrim saying it could not be read. A navigation that gets
 * overtaken is off the hook, because the one that overtook it ends it instead.
 * The one that fails while still being waited for is the last one there is,
 * and leaving it holds the panel on a skeleton that turns for ever -- no
 * conversation, no scrim, and so no way to ask again.
 * @param projectId - The project.
 * @param token - What {@link intendToNavigate} handed back.
 */
function settleIfStranded(projectId: string, token: number): void {
  if (!stillAwaited(projectId, token)) return;
  useStore.setState((s) =>
    s.openStatus[projectId] === 'loading'
      ? { openStatus: { ...s.openStatus, [projectId]: 'failed' } }
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
    const listed = s.listByProject[projectId];
    if (!listed) return s;
    return {
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
  useStore.setState((s) => {
    const listed = s.listByProject[projectId];
    if (!listed) return s;
    const spokenIn = listed.find((c) => c.id === conversationId);
    if (!spokenIn) return s;
    const now = new Date().toISOString();
    return {
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

  // Already the one on screen. Asking again would replace a conversation with
  // an identical copy of itself for no reason.
  if (useStore.getState().currentByProject[projectId] === conversationId) return;

  const visit = currentVisit(projectId);
  try {
    const read = await chatApi.readConversation(conversationId);
    if (visit.signal.aborted) return;
    if (!stillAwaited(projectId, nav)) return;
    adoptConversation(projectId, read);
  } catch (err) {
    // Nothing moves. The reader stays where they were, which is a place that
    // still works, rather than landing on a conversation with no messages in
    // it because the request for them failed.
    if (visit.signal.aborted) return;
    tell({ projectId, conversationId, deliberate: true, ...readMishap(err) });
    // Nothing landed, so the panel is still waiting on this one. If a delete
    // put it in the loading state on the way here, this is where that ends.
    settleIfStranded(projectId, nav);
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
  const visit = currentVisit(projectId);
  try {
    const created = await chatApi.createConversation(projectId);
    if (visit.signal.aborted) return;
    // A switch started before this press may still be out. It was asked for
    // first and will answer whenever it answers, but this is what the reader
    // asked for last, so the row it creates is the one to land on -- and the
    // check inside that switch will see this number and leave the screen
    // alone.
    if (!stillAwaited(projectId, nav)) return;
    useStore.setState((s) => ({
      listByProject: {
        ...s.listByProject,
        // At the top, where the list's order puts the most recently used one.
        [projectId]: [created, ...(s.listByProject[projectId] ?? [])],
      },
    }));
    adoptConversation(projectId, { conversation: created, messages: [], hasMore: false });
  } catch (err) {
    if (visit.signal.aborted) return;
    tell({ projectId, conversationId: null, deliberate: true, ...readMishap(err) });
    // This press may have overtaken a landing that had already promised the
    // panel a conversation -- the one a delete goes looking for, say. That
    // one stepped aside for this; nobody else is coming.
    settleIfStranded(projectId, nav);
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
 * Projects whose last attempt at a next page did not arrive.
 *
 * Held so that reaching the end again counts as asking again. The watcher that
 * notices the end of the list only fires as it is crossed, and a failure moves
 * nothing -- the end stays exactly where it was, in view, and never crosses
 * anything again. Without this the reader would be stuck at the bottom of a
 * list that has more to give, with nothing left that could ask for it.
 */
const lastPageFailed = new Set<string>();

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
  const last = held[held.length - 1]!;

  const visit = currentVisit(projectId);
  fetchingMore.add(projectId);
  lastPageFailed.delete(projectId);
  try {
    const page = await chatApi.listConversations(
      projectId,
      { updatedAt: last.updatedAt, id: last.id },
      visit.signal,
    );
    if (visit.signal.aborted) return;
    useStore.setState((s) => {
      const current = s.listByProject[projectId] ?? [];
      // The page starts after the last row held, so in an order that has not
      // moved these are all new. It can move, though -- another tab, or this
      // one, may have written a row in the meantime -- and a list is one row
      // per conversation whatever happened in between.
      const known = new Set(current.map((c) => c.id));
      const fresh = page.conversations.filter((c) => !known.has(c.id));
      return {
        listByProject: { ...s.listByProject, [projectId]: [...current, ...fresh] },
        listHasMore: { ...s.listHasMore, [projectId]: page.hasMore },
      };
    });
  } catch (err) {
    if (visit.signal.aborted) return;
    lastPageFailed.add(projectId);
    // The reader reached the end themselves, so this is an answer to something
    // they did.
    tell({ projectId, conversationId: null, deliberate: true, ...readMishap(err) });
  } finally {
    fetchingMore.delete(projectId);
  }
}

/**
 * Whether the last attempt at a next page failed.
 *
 * Read by the panel so the watcher that notices the end of the list can be
 * rebuilt: a fresh watcher reports where things stand as soon as it starts, so
 * an end that is already in view counts again.
 * @param projectId - The project.
 * @returns True when the last attempt failed and nothing has been tried since.
 */
function nextPageFailed(projectId: string): boolean {
  return lastPageFailed.has(projectId);
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
    tell({ projectId, conversationId, deliberate: true, ...readMishap(err) });
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
    // The row stays. A list that has lost a conversation the server still has
    // is worse than one that failed to lose it, because only the second is
    // something the reader can retry.
    if (visit.signal.aborted) return;
    tell({ projectId, conversationId, deliberate: true, ...readMishap(err) });
    return;
  }
  if (visit.signal.aborted) return;

  // Whatever it was running stops with it. Leaving the turn to finish would
  // go on calling the model, and being billed for it, on behalf of a
  // conversation that no longer exists.
  stopTurn(conversationId);

  const remaining = (useStore.getState().listByProject[projectId] ?? []).filter(
    (c) => c.id !== conversationId,
  );
  useStore.setState((s) => {
    const { [conversationId]: _gone, ...conversations } = s.conversations;
    const { [conversationId]: _draft, ...draftByConversation } = s.draftByConversation;
    return {
      conversations,
      draftByConversation,
      listByProject: { ...s.listByProject, [projectId]: remaining },
    };
  });

  // Read now, not before the request went out. Whether this conversation is
  // the one on screen is a question about the moment it disappears, and in
  // between the reader may have picked another row -- deciding at the start
  // would pull them off it.
  if (useStore.getState().currentByProject[projectId] !== conversationId) return;

  // Landing somewhere else is a navigation like any other, and it has to be
  // ordered against the reader's own: whatever they pressed after this must
  // win over the row this picks for them.
  const nav = intendToNavigate(projectId);

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
    // Not `switchTo`: that one returns early when the id it is given is
    // already the current one, and the current one is the conversation just
    // deleted only when this is the last press of two. Read it directly.
    const visit = currentVisit(projectId);
    try {
      const read = await chatApi.readConversation(next.id);
      if (visit.signal.aborted) return;
      if (!stillAwaited(projectId, nav)) return;
      adoptConversation(projectId, read);
    } catch (err) {
      if (visit.signal.aborted) return;
      useStore.setState((s) => ({
        openStatus: { ...s.openStatus, [projectId]: 'failed' },
      }));
      tell({ projectId, conversationId: next.id, deliberate: true, ...readMishap(err) });
    }
    return;
  }
  // None left. `openAndAdopt` rather than `ensureLoaded`, because by that
  // one's reckoning this project is open already and it would return without
  // asking for the conversation that no longer exists.
  const failure = await openAndAdopt(projectId);
  if (failure) {
    useStore.setState((s) => ({
      openStatus: { ...s.openStatus, [projectId]: 'failed' },
    }));
    tell({ projectId, conversationId: null, deliberate: true, ...readMishap(failure.failed) });
  }
}

/**
 * Where a draft is kept while the conversation it belongs to is still loading.
 *
 * A draft belongs to a conversation, and for a moment on every visit there is
 * no conversation to belong to -- the open call is still out. Typing in that
 * moment used to be dropped on the floor: nowhere to put it meant the box
 * showed nothing back. So it goes under the project until there is somewhere
 * better, and moves the moment there is.
 * @param projectId - The project being read.
 * @returns The key drafts are kept under while no conversation is on screen.
 */
export function projectDraftKey(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * Hold what is half-typed, under the conversation if there is one.
 * @param projectId - The project being read.
 * @param conversationId - The conversation it was typed in, if one is on screen.
 * @param text - What is in the box.
 */
function setDraft(projectId: string, conversationId: string | undefined, text: string): void {
  const key = conversationId ?? projectDraftKey(projectId);
  useStore.setState((s) => ({
    draftByConversation: { ...s.draftByConversation, [key]: text },
  }));
}

/**
 * Read back what was half-typed.
 * @param projectId - The project being read.
 * @param conversationId - The conversation asked about, if one is on screen.
 * @returns What is in its box, empty when nothing was left there.
 */
function draftOf(projectId: string, conversationId: string | undefined): string {
  const key = conversationId ?? projectDraftKey(projectId);
  return useStore.getState().draftByConversation[key] ?? '';
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
    const { [projectId]: _sending, ...sendingByProject } = s.sendingByProject;
    const { [projectId]: _listed, ...listByProject } = s.listByProject;
    const { [projectId]: _more, ...listHasMore } = s.listHasMore;
    // The drafts of every conversation in this project go with it. A draft
    // belongs to a conversation the reader was in, and coming back re-opens
    // the project from the server -- so keeping them would hand a returning
    // reader half a sentence they typed in a session they have left.
    const keptDrafts: Record<string, string> = {};
    const waitingKey = projectDraftKey(projectId);
    for (const [id, draft] of Object.entries(s.draftByConversation)) {
      // The one typed before this project had a conversation is keyed by the
      // project, not by a conversation, so asking which conversation it
      // belongs to finds nothing and keeps it -- and the next visit hands it
      // to whichever conversation happens to open.
      if (id === waitingKey) continue;
      if (s.conversations[id]?.projectId !== projectId) keptDrafts[id] = draft;
    }
    return {
      conversations: kept,
      currentByProject,
      openStatus,
      sendingByProject,
      listByProject,
      listHasMore,
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
  lastPageFailed.delete(projectId);
  navigations.delete(projectId);
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
  useStore.setState({
    conversations: {},
    currentByProject: {},
    listByProject: {},
    listHasMore: {},
    draftByConversation: {},
    openStatus: {},
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
  nextPageFailed,
  rename,
  remove,
  setDraft,
  draftOf,
};
