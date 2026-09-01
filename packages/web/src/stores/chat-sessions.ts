// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 */
import { Chat } from '@ai-sdk/react';
import { tell } from '@web/stores/chat-mishaps';
import { DefaultChatTransport } from 'ai';
import type { ChatTransport, UIMessageChunk } from 'ai';
import { SSE_HEARTBEAT_MISSES_ALLOWED } from '@breatic/shared';
import { API_BASE_PATH } from '@web/data/api/base-path';
import { chatApi } from '@web/data/api/chat';
import { clearConsolidating, noteConsolidating } from '@web/stores/consolidating';
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
  /**
   * Called once per turn, when the first frame of it arrives.
   *
   * What it is for is emptying the composer, which happens then and not at the
   * press: before the first frame the words are only in the box the reader
   * typed them into, and a turn the server refuses leaves them exactly there
   * with nothing to put back.
   *
   * It is told from here rather than watched from a panel because a panel is
   * not always there to watch. Collapsing the agent column or switching to
   * another conversation unmounts it while the turn goes on (A4), and a turn
   * whose first frame lands in that gap would never have its box emptied --
   * while a panel coming back to a turn already streaming would empty it a
   * second time, over whatever the reader has typed since.
   */
  onFirstFrame: () => void;
}

/** The chunk the server names a conversation on. */
const TITLED = 'data-conversation-titled';

/** The chunk the server says a turn stopped to fold memory on. */
const CONSOLIDATING = 'data-memory-consolidating';

/** Every conversation whose state is being kept, by conversation id. */
const sessions = new Map<string, Chat<StoredUiMessage>>();

/**
 * Which project each of them belongs to.
 *
 * Kept beside the sessions because a word about a turn is addressed to a
 * project as well as to a conversation, and the turn is run from here.
 */
const projectOf = new Map<string, string>();

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
 * Whether this frame is one the reader will see something of.
 *
 * Not every frame is. A transient data part is handed to `onData` and dropped
 * there (`ai@7.0.68` `index.js:7416`: `if (dataChunk.transient) { onData(...);
 * break; }`) -- it never reaches `write()`, so it does not become a message
 * part and does not move `status` off `submitted`.
 *
 * The heartbeat is exactly that, and it is the first thing on every stream:
 * the route writes one the moment there is a socket, before the interval even
 * starts (`routes/chat.ts:141`). So "the first frame" read literally is always
 * the beat, which is the one frame that means the turn has said nothing yet.
 * @param chunk - One frame off the wire.
 * @returns True when this frame is part of the answer.
 */
function isAnswering(chunk: UIMessageChunk): boolean {
  return !(chunk.type.startsWith('data-') && 'transient' in chunk && chunk.transient === true);
}

/**
 * Say when a turn starts answering, and pass every frame along untouched.
 *
 * This is the one place the moment is observable. `Chat` builds its own state
 * object and takes no subscription to it, so `status` going from `submitted`
 * to `streaming` -- which the SDK does on the first frame that reaches
 * `write()` (`ai@7.0.68` `index.js:17974`) -- cannot be watched from outside
 * except by a render that happens to be mounted.
 *
 * Which is why the beats have to be skipped rather than counted: telling the
 * caller on the beat would empty the composer while the SDK still has the
 * reader's message held out of the list, and the sentence would be in neither
 * place until the answer began.
 * @param stream - The turn's stream, as the transport built it.
 * @param onAnswering - Told on every frame that carries an answer.
 * @param onFirstFrame - Told once, on the first of them.
 * @returns The same frames, in the same order.
 */
function sayWhenItOpens(
  stream: ReadableStream<UIMessageChunk>,
  onAnswering: () => void,
  onFirstFrame: () => void,
): ReadableStream<UIMessageChunk> {
  let answering = false;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (isAnswering(chunk)) {
          onAnswering();
          if (!answering) {
            answering = true;
            onFirstFrame();
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Build the transport one conversation's turns go out on.
 *
 * The body is ours, not the protocol's: the server takes one message and the
 * ids that say where it belongs, and works out the history itself from what it
 * has stored. Sending the whole message list would be the browser telling the
 * server what the conversation contains.
 * @param projectId - The project the conversation is in.
 * @param conversationId - The conversation being written to.
 * @param onFirstFrame - Told when this conversation's turn starts answering.
 * @returns A transport pointed at the chat endpoint.
 */
function transportFor(
  projectId: string,
  conversationId: string,
  onFirstFrame: () => void,
): ChatTransport<StoredUiMessage> {
  const wire = new DefaultChatTransport<StoredUiMessage>({
    // Built from the one definition of the prefix rather than spelled out.
    // Two spellings is how both streaming endpoints once came to post at an
    // address the server does not serve, with nothing complaining.
    api: `${API_BASE_PATH}/chat/message`,
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
  return {
    sendMessages: async (options) =>
      sayWhenItOpens(
        await wire.sendMessages(options),
        // On every answering frame, because the fold begins after the turn
        // has already opened: the server writes the conversation's name
        // first, every turn, and only then stops to fold. Clearing on the
        // first frame alone would run before the fold had said anything and
        // never run again.
        () => clearConsolidating(conversationId),
        () => {
          // The turn is always there when a frame arrives: a stream is only
          // read while its turn is running, and both ways one ends -- the
          // stream closing, or the reader stopping it -- take the reader's
          // end of the pipe away first, after which nothing more is pulled
          // through this transform. So this branch exists because the map
          // answers `number | undefined`, not because there is a frame it
          // turns away. Both halves are behind it anyway: they are one
          // signal, and a guard that let one through would be saying they
          // are two.
          const turn = runningTurn.get(conversationId);
          if (turn === undefined) return;
          answeredTurn.set(conversationId, turn);
          onFirstFrame();
        },
      ),
    reconnectToStream: (options) => wire.reconnectToStream(options),
  };
}

/**
 * The sentence our own server wrote, read out of a raw response body.
 *
 * Named for where it reads from, because `chat-mishaps` has one answering the
 * same question off a different input: everything that goes through axios
 * arrives as an `ApiException` with the envelope already taken apart, and can
 * just ask it. A turn cannot -- see below.
 *
 * What the transport throws for a refused turn is `new Error(responseText)`
 * (`ai@7.0.68` `dist/index.js:17351`) -- the body and nothing else, no status
 * on it. So a sentence of our own is recognised by its envelope, and the
 * envelope is the one `middleware/error-handler.ts` writes:
 * `{ error: { code, message } }`. Anything else that answered -- a gateway, a
 * proxy, a page of HTML -- is not ours to quote.
 *
 * A conversation the server no longer has is one of these, and it gets the
 * same treatment as the rest: said, and left. Opening a replacement and
 * putting the words on it would leave the reader watching their own sentence
 * appear in a conversation they were not in, while the one on screen still
 * shows the history it always had.
 * @param error - Whatever the turn ended with.
 * @returns The server's own words, or undefined if what answered was not ours.
 */
function serverSentenceInBody(error: unknown): string | undefined {
  const body = error instanceof Error ? error.message : '';
  try {
    const envelope: unknown = JSON.parse(body);
    if (
      typeof envelope === 'object' &&
      envelope !== null &&
      'error' in envelope &&
      typeof envelope.error === 'object' &&
      envelope.error !== null &&
      'message' in envelope.error &&
      typeof envelope.error.message === 'string'
    ) {
      return envelope.error.message;
    }
  } catch {
    // Not JSON at all, which is what a gateway or a dropped connection
    // leaves. The panel writes its own sentence for that.
  }
  return undefined;
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

/** The wait each running conversation is under, by conversation id. */
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * How many turns each conversation has run, so a turn can be named.
 *
 * A turn is the unit everything about a running conversation belongs to, and
 * until now nothing named one -- which is why work started for one turn could
 * land on the conversation after that turn was over.
 */
const turnsRun = new Map<string, number>();

/** Which turn each conversation is running right now, if any. */
const runningTurn = new Map<string, number>();

/**
 * The turns that got as far as an answer starting, by conversation.
 *
 * Which is also the answer to "has the server got this sentence": the route
 * opens the stream and beats on it before the turn runs at all, but the first
 * frame that carries anything comes from the turn itself -- and the turn
 * stores the reader's message on its first line (`main-agent.ts`, the
 * `addMessage` before anything else) before it can produce one.
 *
 * So one signal settles two things: when to empty the composer, and whether
 * taking the sentence back would be taking back something the server has
 * already written down.
 */
const answeredTurn = new Map<string, number>();

/** The chunk the server proves a running stream alive with. */
const BEAT = 'data-heartbeat';

/**
 * Stop waiting on a conversation, whichever way its turn ended.
 * @param conversationId - The conversation whose turn is over.
 */
function stopWatching(conversationId: string): void {
  const waiting = watchdogs.get(conversationId);
  if (waiting !== undefined) clearTimeout(waiting);
  watchdogs.delete(conversationId);
}

/**
 * Give up on a stream that has stopped saying it is alive.
 *
 * The turn is ended the way pressing stop ends one, but the reader pressed
 * nothing -- so unlike stop, this is worth a word.
 *
 * Everything that happens next belongs to {@link settleTurn}, which every
 * ending goes through. All this decides is which of the two silent endings
 * this was: stopping is stopping as far as the SDK is concerned, and only one
 * of them is news to the reader.
 * @param conversationId - The conversation whose turn is being given up on.
 */
function giveUpOn(conversationId: string): void {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  // Everything that follows is `onFinish`'s, the way it is for every other way
  // a turn can end. All this leaves behind is which of the two silent ways
  // this was, because stopping is stopping as far as the SDK is concerned and
  // only one of them is worth a word.
  givenUpOn.add(conversationId);
  void chat.stop();
}

/**
 * The conversations whose current turn was given up on rather than stopped.
 *
 * Pressing stop and running out of heartbeats both reach the SDK as an abort
 * and are indistinguishable there. They differ in one thing: a reader who
 * pressed stop knows why the answer ended, and one whose connection died does
 * not, so only the second is told anything.
 */
const givenUpOn = new Set<string>();

/**
 * Settle a turn, whichever way it ended.
 *
 * The one place a turn's ending is written down. Every way out arrives here:
 * `onFinish` runs in `makeRequest`'s `finally` (`ai@7.0.68`
 * `index.js:18038`), so a turn that finished, one that was aborted and one
 * that failed before its stream ever opened all pass through -- the last of
 * those because `activeResponse` is set before `sendMessages` is called
 * (`:17941` before `:17950`).
 *
 * Having one place is the point rather than a tidiness. Split across an error
 * handler and a watchdog, each did part of it: a turn the server refused kept
 * the reader's sentence in the list while the same sentence sat in the
 * composer, and nothing but the watchdog ever took one back.
 * @param conversationId - The conversation whose turn ended.
 * @param how - What the SDK says about how it ended.
 * @param how.isAbort - This end stopped it.
 * @param how.isDisconnect - Nothing answered, or the answer stopped arriving.
 * @param how.isError - It ended by failing.
 */
function settleTurn(
  conversationId: string,
  how: { isAbort: boolean; isDisconnect: boolean; isError: boolean },
): void {
  const gaveUp = givenUpOn.delete(conversationId);
  stopWatching(conversationId);
  runningTurn.delete(conversationId);
  // A turn that failed, was stopped, or folded and then said nothing would
  // otherwise leave the line up — and it says something about a turn that is
  // over, still there the next time this conversation is opened.
  clearConsolidating(conversationId);
  const chat = sessions.get(conversationId);
  if (!chat) return;
  const projectId = projectOf.get(conversationId) ?? '';

  // Whether this turn ever began answering. Not read off the message list:
  // the list only says whether a reply was pushed here, and a turn can have
  // been stored on the server without one.
  const beganAnswering = answeredTurn.has(conversationId);
  answeredTurn.delete(conversationId);
  const last = chat.messages[chat.messages.length - 1];

  if (how.isAbort || how.isError) {
    if (!beganAnswering && last?.role === 'user') {
      // Take it back, and only here. Nothing of this turn ever began, which
      // means the server refused it before the turn ran -- so there is
      // nothing stored to contradict, the renderer is still holding the
      // message out of the list, and the composer still has the same words.
      // Left alone the sentence would be in two places and sending again
      // would say it twice.
      //
      // Once an answer has begun the sentence is the server's record, not
      // this browser's draft: taking it back here would leave the screen
      // disagreeing with what a reload reads.
      chat.messages = chat.messages.slice(0, -1);
    } else if (last?.role === 'assistant') {
      markTheReply(chat, how.isAbort ? 'data-interrupted' : 'data-failed');
    }
  }

  if (gaveUp) {
    tell({ projectId, conversationId, kind: 'network' });
    return;
  }
  // A reader who pressed stop knows what they did.
  if (how.isAbort || !how.isError) return;
  const said = serverSentenceInBody(chat.error);
  if (said !== undefined) {
    tell({ projectId, conversationId, kind: 'server', message: said });
    return;
  }
  tell({ projectId, conversationId, kind: how.isDisconnect ? 'network' : 'turn' });
}

/**
 * Start, or restart, the wait for the next beat.
 *
 * The budget runs from the press rather than from the first beat: a request
 * that never opens at all is the one case nothing else reports, and it has to
 * be covered. So the deadline is worked out against when the press happened,
 * and asking the server how long the budget is -- which is itself a request --
 * spends part of it rather than resetting it.
 * @param conversationId - The conversation being waited on.
 * @param turn - Which turn of it this wait belongs to.
 * @param pressedAt - When the reader pressed send.
 */
async function expectAnotherBeat(
  conversationId: string,
  turn: number,
  pressedAt: number,
): Promise<void> {
  let heartbeatIntervalMs: number;
  try {
    ({ heartbeatIntervalMs } = await chatApi.streamConfig());
  } catch (failed) {
    // Nothing is said to the reader: their turn is running and there is
    // nothing for them to do about a request they did not make. What it costs
    // is this turn going unwatched -- a stream that dies quietly will hang
    // rather than end -- so it is written down where an operator can find it
    // rather than swallowed.
    console.error('[chat] the turn is running unwatched: no stream config', failed);
    return;
  }
  // The turn this wait was for is over, or a later one has started. Asking
  // whether the session is still here would not catch either: a session
  // outlives every turn it runs, so arming on that answer puts a timer on an
  // idle conversation, and fifteen seconds later it marks a finished reply as
  // cut off and reports a network problem to a reader with nothing running.
  if (runningTurn.get(conversationId) !== turn) return;
  stopWatching(conversationId);
  const spent = Date.now() - pressedAt;
  const left = heartbeatIntervalMs * SSE_HEARTBEAT_MISSES_ALLOWED - spent;
  watchdogs.set(
    conversationId,
    setTimeout(() => giveUpOn(conversationId), Math.max(left, 0)),
  );
}

/**
 * Say one thing in a conversation, and watch the stream it comes back on.
 *
 * The one way a turn is started. Everything a running turn needs looking
 * after -- the wait for the next beat, and the giving up when none comes --
 * belongs with the session rather than with whichever panel pressed the
 * button, for the same reason the session does.
 * @param conversationId - The conversation to say it in.
 * @param said - What the reader typed, trimmed.
 * @returns When the turn is over, however it ended.
 */
export async function sendInSession(conversationId: string, said: string): Promise<void> {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  const pressedAt = Date.now();
  const turn = (turnsRun.get(conversationId) ?? 0) + 1;
  turnsRun.set(conversationId, turn);
  runningTurn.set(conversationId, turn);
  void expectAnotherBeat(conversationId, turn, pressedAt);
  try {
    await chat.sendMessage({ text: said });
  } catch {
    // Already said. `Chat` hands whatever went wrong to its own `onFinish`
    // before it rethrows, and that is where the turn was settled -- so what
    // reaches here is a second copy of news that has been delivered. Letting
    // it out would make every caller catch a failure they cannot add to, and
    // the press that started this is a click handler with nothing above it.
  }
}

/**
 * Stop the turn a conversation is running, as the reader asked.
 *
 * Stopping is what this end can do; whether the server sees it as the reader
 * stopping or as the connection dying, it records the turn the same way. What
 * this end knows -- that the reply was cut off -- is written down where every
 * other ending is, in {@link settleTurn}.
 * @param conversationId - The conversation to stop.
 */
export function stopChatSession(conversationId: string): void {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  void chat.stop();
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

  const { projectId, conversationId, onTitled, onFirstFrame } = init;
  const chat = new Chat<StoredUiMessage>({
    id: conversationId,
    messages: init.history,
    transport: transportFor(projectId, conversationId, onFirstFrame),
    onData: (part) => {
      if (part.type === BEAT) {
        const turn = runningTurn.get(conversationId);
        if (turn !== undefined) void expectAnotherBeat(conversationId, turn, Date.now());
        return;
      }
      if (part.type === CONSOLIDATING) {
        noteConsolidating(conversationId);
        return;
      }
      if (part.type !== TITLED) return;
      const { title } = part.data as { title: string | null };
      onTitled(title);
    },
    // On the instance rather than on `useChat`: the hook only keeps callbacks
    // it was given when it was not handed a chat.
    //
    // Only `onFinish` is taken. It runs for every ending including this one
    // (`ai@7.0.68` `index.js:18031` then the `finally` at `:18036`), and
    // taking both would mean two handlers deciding what a failed turn leaves
    // behind -- which is the split this replaced.
    onFinish: ({ isAbort, isDisconnect, isError }) => {
      settleTurn(conversationId, { isAbort, isDisconnect, isError });
    },
  });
  sessions.set(init.conversationId, chat);
  projectOf.set(init.conversationId, projectId);
  return chat;
}

/**
 * Whether this conversation's state is already being kept here.
 *
 * Asked by whoever holds the rest of what is true of a conversation on
 * screen. The list is here once a session exists, and everything derived from
 * that list -- how far back it reaches, whether there is more behind it --
 * has to stay with it rather than being recomputed from a page the server
 * happens to hand out later.
 * @param conversationId - Which conversation.
 * @returns True when a session for it exists.
 */
export function hasChatSession(conversationId: string): boolean {
  return sessions.has(conversationId);
}

/**
 * Put a page of older messages at the head of a conversation's list.
 *
 * What "load earlier" reads back has to reach the list the panel is drawing,
 * and that list is here. Written to the store as well, but a session that
 * already exists never re-reads what the store holds -- it cannot, or a
 * history read while a turn is running would replace the reply being written
 * with a snapshot taken before it existed.
 *
 * The head is the half no turn touches: a reply is appended to the tail, so
 * the two writers never contend.
 *
 * Nothing happens when the conversation has no session here -- it was deleted,
 * or the project was left, while the page was on its way.
 * @param conversationId - The conversation reaching further back.
 * @param earlier - The page, oldest first.
 */
export function prependHistory(conversationId: string, earlier: StoredUiMessage[]): void {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  chat.messages = [...earlier, ...chat.messages];
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
  stopWatching(conversationId);
  sessions.delete(conversationId);
  projectOf.delete(conversationId);
  turnsRun.delete(conversationId);
  runningTurn.delete(conversationId);
  answeredTurn.delete(conversationId);
  givenUpOn.delete(conversationId);
}

/**
 * Drop every conversation's state.
 *
 * For leaving a project, where what is being left is all of them at once.
 */
export function evictAllChatSessions(): void {
  for (const [id, chat] of sessions) {
    void chat.stop();
    stopWatching(id);
  }
  sessions.clear();
  projectOf.clear();
  turnsRun.clear();
  runningTurn.clear();
  answeredTurn.clear();
  givenUpOn.clear();
}
