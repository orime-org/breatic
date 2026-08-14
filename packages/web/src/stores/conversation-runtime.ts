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

/** How far opening one project's chat has got. */
export type OpenStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface ConversationRuntimeState {
  /** Keyed by conversation id. */
  conversations: Record<string, ConversationRuntime>;
  /** Which conversation each project is showing. */
  currentByProject: Record<string, string>;
  /** How far each project's open call has got. */
  openStatus: Record<string, OpenStatus>;
}

/**
 * Opens already under way, so a second caller waits rather than asking again.
 *
 * Outside the state because a promise is not something to render; nothing
 * subscribes to it and putting it in state would make every subscriber
 * recompute when a request starts and again when it lands.
 */
const opening = new Map<string, Promise<void>>();

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
const loadingEarlier = new Map<string, Promise<void>>();

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
  /** The project it happened in. */
  projectId: string;
  /** The conversation, or null when there is not one yet to speak of. */
  conversationId: string | null;
} & ({ kind: 'network' } | { kind: 'server'; message: string });

const watchers = new Set<(mishap: ChatMishap) => void>();

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
function tell(mishap: ChatMishap): void {
  for (const watch of watchers) watch(mishap);
}

/**
 * Read a failed request as the reader would hear it.
 * @param err - Whatever the call threw.
 * @returns Which kind of mishap it is, and the server's own words when it
 *   answered with any.
 */
function readMishap(err: unknown): { kind: 'network' } | { kind: 'server'; message: string } {
  if (err instanceof StreamRefusedError) return { kind: 'server', message: err.message };
  // An ApiException carries the status the server answered with, and zero
  // when there was no answer to read one from.
  if (err instanceof ApiException && err.status !== 0) {
    return { kind: 'server', message: err.message };
  }
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
  const status = useStore.getState().openStatus[projectId];
  if (status === 'ready') return;

  const inFlight = opening.get(projectId);
  if (inFlight) return inFlight;

  const visit = currentVisit(projectId);
  const attempt = (async (): Promise<void> => {
    useStore.setState((s) => ({ openStatus: { ...s.openStatus, [projectId]: 'loading' } }));
    try {
      const opened = await chatApi.openChat(projectId, visit.signal);
      if (visit.signal.aborted) return;
      adoptConversation(projectId, opened.current);
    } catch (err) {
      // What went wrong is the panel's to show, and it shows one thing for
      // every way this can fail: there is no conversation to write to. The
      // request itself is where a failure is worth its own words, and it says
      // them there.
      //
      // Except when the visit that asked is over, which includes this refusal
      // being the abort itself. Saying so then would replace a conversation
      // the reader is looking at now with the news that a request they walked
      // away from did not work.
      if (visit.signal.aborted) return;
      useStore.setState((s) => ({ openStatus: { ...s.openStatus, [projectId]: 'failed' } }));
      tell({ projectId, conversationId: null, ...readMishap(err) });
    } finally {
      opening.delete(projectId);
    }
  })();

  opening.set(projectId, attempt);
  return attempt;
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
 * the part that had already arrived here. So the sentence the panel shows
 * claims nothing about the other end. It says the reply is not all here and
 * offers to read it again, which is true in every one of those cases.
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
      patchConversation(conversationId, (c) => {
        // Belonging to a turn that is already over -- stopped, or given up on
        // by the watchdog -- this describes a conversation nobody is waiting
        // for an answer about, and taking the screen over on its behalf would
        // hand back a reply slot nothing will ever finish writing.
        if (c.turn?.replyId !== replyId) return c;
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
          turn: { ...c.turn, started: true },
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

    case SSE_EVENT_NAMES.ERROR:
      // What the server says here is a hardcoded English sentence; the panel
      // shows its own wording, so only the fact matters.
      patchMessage(conversationId, replyId, (m) => ({ ...m, failed: true }));
      patchConversation(conversationId, (c) => ({
        ...c,
        failures: c.failures + 1,
        failedReplyId: replyId,
      }));
      finishTurn(conversationId, replyId);
      break;

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
 * @param conversationId - The conversation to write it to.
 * @param text - What the user said.
 * @returns The refusal that ended it, when one did.
 */
async function runTurn(conversationId: string, text: string): Promise<NeverRan | undefined> {
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
  // the composer disabled the whole time. Missing beats end the turn the same
  // way pressing stop does, because from here the two are the same fact:
  // nothing more is coming.
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
      if (useStore.getState().conversations[conversationId]?.turn?.replyId !== replyId) return;
      const projectId = useStore.getState().conversations[conversationId]?.projectId ?? '';
      stopTurn(conversationId);
      // Ended the same way pressing stop does, but the reader did not press
      // anything, so unlike stop this one is worth a word.
      tell({ projectId, conversationId, kind: 'network' });
    }, SSE_HEARTBEAT_TIMEOUT_MS);
  };
  expectAnotherBeat();

  let neverRan: NeverRan | undefined;

  await chatApi.streamMessage(
    { projectId: useStore.getState().conversations[conversationId]?.projectId ?? '', conversationId, message: text },
    {
      signal: abort.signal,
      onEvent: (event) => {
        expectAnotherBeat();
        applyEvent(conversationId, replyId, event);
      },
      onClose: () => finishTurn(conversationId, replyId),
      onError: (err: unknown) => {
        // Three endings, and the panel can only say something true about one
        // it can tell from the others.
        // Every ending here is one the reader did not ask for, so each is
        // worth one line. Which line depends only on whether the server got
        // to answer: an answer at all means the network was fine.
        if (
          useStore.getState().conversations[conversationId]?.turn?.replyId === replyId ||
          err instanceof StreamRefusedError ||
          err instanceof StreamUnreachableError
        ) {
          tell({
            projectId: useStore.getState().conversations[conversationId]?.projectId ?? '',
            conversationId,
            ...readMishap(err),
          });
        }
        if (err instanceof StreamRefusedError || err instanceof StreamUnreachableError) {
          // The server answered and said no, or the request never left. Either
          // way the turn never ran, which the caller needs to know: one of the
          // two is worth trying again, and the words are still in the box.
          neverRan = err;
        } else if (
          err instanceof StreamDroppedError &&
          useStore.getState().conversations[conversationId]?.turn?.replyId === replyId
        ) {
          // The stream opened and then died. The server sees that as the
          // client going away and cannot tell it from the user pressing stop,
          // so it records the turn as stopped and this says the same. Guarded
          // on this still being the turn that is running: an error arriving
          // late belongs to a turn that already ended, and marking it would
          // put "stopped" on a reply that finished.
          patchMessage(conversationId, replyId, (m) => ({ ...m, interrupted: true as const }));
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
 * Say one thing in a project's chat and stream the reply into it.
 * @param projectId - The project whose chat this is.
 * @param text - What the user said.
 * @throws {Error} When there is no conversation to write to, or the attempt
 *   never reached the server. Both mean the words were not sent -- which is
 *   why the composer empties its box on the turn's first event rather than on
 *   the press, so there is nothing to hand back.
 */
async function send(projectId: string, text: string): Promise<void> {
  const conversationId = useStore.getState().currentByProject[projectId];
  if (!conversationId) throw new Error('chat is not open');

  const ending = await runTurn(conversationId, text);
  if (!ending) return;
  if (ending instanceof StreamUnreachableError) throw ending;

  // Only one refusal is worth a second try. A conversation can be deleted
  // from another tab while this one still holds its id, and that is not
  // something the user did or can act on; every other refusal -- no
  // permission, a project that is gone -- says trying again is pointless.
  if (ending.status !== NOT_FOUND) throw ending;

  // Opening a fresh one can fail too, and when it does the turn is over with
  // nothing to show for it. Letting that out is what hands the words back;
  // making up a reply here would put a turn on screen the server has no
  // record of.
  const visit = currentVisit(projectId);
  const fresh = await chatApi.openChat(projectId, visit.signal);
  // Left while this was on its way, so there is no screen to put a
  // conversation on and nobody waiting for the words to go out again.
  if (visit.signal.aborted) return;
  adoptConversation(projectId, fresh.current);

  // A plain turn, not a resumed one: the first attempt never put anything on
  // screen, and adopting the new conversation replaced the list besides.
  // Nothing of the attempt is left to reuse, so the words go on again with the
  // turn that is re-sending them.
  const secondEnding = await runTurn(fresh.current.conversation.id, text);
  if (secondEnding) throw secondEnding;
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

  const inFlight = loadingEarlier.get(conversationId);
  if (inFlight) return inFlight;

  const visit = currentVisit(before.projectId);
  const attempt = (async (): Promise<void> => {
    // Pressing again is what makes the last failure old news, and pressing
    // again is what just happened.
    patchConversation(conversationId, (c) => ({ ...c, earlierFailed: false }));
    try {
      const earlier = await chatApi.messagesBefore(conversationId, beforeTurn, visit.signal);
      // `beforeTurn` was read from the list this visit is looking at. If the
      // visit is over, the list has been read again from the top, and putting
      // this page at its head would leave everything between them missing
      // with nothing on screen saying so -- and move the cursor past the gap,
      // so no press could ever ask for it.
      if (visit.signal.aborted) return;
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
    } finally {
      loadingEarlier.delete(conversationId);
    }
  })();

  loadingEarlier.set(conversationId, attempt);
  return attempt;
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
    // Its page is on its way to a conversation this visit will not be reading
    // any more. Dropped rather than left to settle, because a press made
    // after coming back would otherwise join this request instead of making
    // one -- and this one is going to write nothing.
    loadingEarlier.delete(id);
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
    return { conversations: kept, currentByProject, openStatus };
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
  useStore.setState({ conversations: {}, currentByProject: {}, openStatus: {} });
}

export const useConversationRuntime = useStore;

export const conversationRuntime = {
  ensureLoaded,
  send,
  stopTurn,
  loadEarlier,
  leaveProject,
};
