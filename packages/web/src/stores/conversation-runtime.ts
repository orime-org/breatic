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
import type { OpenChatResult } from '@web/data/api/chat';
import { useChatStore } from '@web/stores/chat';
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
 * Earlier pages already being fetched, keyed by the conversation asked about.
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
 * The two kinds are not a matter of wording. Getting an answer at all means
 * the network is fine, so `server` carries the sentence the server wrote --
 * out of credits, too many requests, not allowed -- and `network` means no
 * answer came back and there is nothing to quote.
 */
export type ChatMishap = {
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
  const visit = currentVisit(projectId);
  // Only from the start. This says what the chat has come to be, not whether
  // a request is out -- that is what `opening` and `sendingByProject` are for.
  // Going back to `loading` for a re-open takes the whole message column off
  // the screen (the list renders nothing while this says loading), and a
  // re-open is something a press causes: the reader would press send and watch
  // their conversation disappear.
  useStore.setState((s) =>
    s.openStatus[projectId] === undefined || s.openStatus[projectId] === 'idle'
      ? { openStatus: { ...s.openStatus, [projectId]: 'loading' } }
      : s,
  );
  try {
    const opened = await chatApi.openChat(projectId, visit.signal);
    if (visit.signal.aborted) return undefined;
    adoptConversation(projectId, opened.current);
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
 * Rebuilds the entry rather than merging into it, turn included: this is an
 * answer describing the whole conversation, so anything kept from before it
 * would be state the server has just contradicted. That is also why callers
 * must not reach here with an answer to a visit that is over -- see
 * {@link visits} -- and why every one of them checks first.
 * @param projectId - The project showing it.
 * @param opened - The conversation, its newest page, and whether the
 *   conversation reaches back further than that page does.
 */
function adoptConversation(projectId: string, opened: OpenChatResult['current']): void {
  const conversationId = opened.conversation.id;
  useStore.setState((s) => ({
    openStatus: { ...s.openStatus, [projectId]: 'ready' },
    currentByProject: { ...s.currentByProject, [projectId]: conversationId },
    conversations: {
      ...s.conversations,
      [conversationId]: {
        projectId,
        messages: opened.messages.map(toStored),
        turn: null,
        hasMore: opened.hasMore,
        oldestLoadedTurn: oldestTurnOf(opened.messages),
        failures: 0,
        failedReplyId: null,
      },
    },
  }));
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
      useChatStore.getState().setComposerDraft('');

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
 *   kept whole so the same words can be taken back out of the box.
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
    return { conversations: kept, currentByProject, openStatus, sendingByProject };
  });
  opening.delete(projectId);
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
};
