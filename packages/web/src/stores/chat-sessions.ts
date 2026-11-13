// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The messages of each conversation, and reading the run that holds one.
 *
 * A `Chat` instance holds one conversation's messages. It lives here, keyed by
 * conversation, so collapsing the agent column is collapsing a column rather
 * than losing what is on screen -- and so is switching to another
 * conversation and back.
 *
 * A run is not started from here (inner#1717). It runs on the server, behind
 * the conversation's queue, and this end reads it: before attaching, the
 * newest page of history is read back and laid over the list, then the run's
 * stream is resumed from its start through `GET /chat/conversations/:id/stream`.
 * Whatever an earlier attach drew of the same run is replaced by that page, so
 * a replayed run is drawn once. When to attach is `stores/chat-live`'s call.
 *
 * Callbacks go to the instance and not to `useChat`. Measured on
 * `@ai-sdk/react@4.0.71` (`dist/index.js:301-311`): the hook only stores the
 * callbacks it was passed when it was *not* given a `chat`, so ones handed to
 * a `useChat({ chat })` are never called.
 */
import { Chat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { ChatTransport, UIMessageChunk } from 'ai';
import { SSE_HEARTBEAT_MISSES_ALLOWED, getLocale } from '@breatic/shared';
import type { AskUserResult } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import type { StoredUiMessage } from '@web/data/api/chat';
import { clearConsolidating, noteConsolidating } from '@web/stores/consolidating';
import { chatWaiting } from '@web/stores/chat-waiting';
import { clearRunningTurns, noteTurnSettled } from '@web/stores/running-turns';

/** What starting a conversation's state takes. */
export interface ChatSessionInit {
  /** The project it belongs to. */
  projectId: string;
  /**
   * Which conversation, and the key this is held under.
   *
   * Undefined while a panel is still finding out which one it is showing --
   * see {@link NOTHING_OPEN}.
   */
  conversationId: string | undefined;
  /**
   * What the store had for it, as the starting point. Used only when there is
   * nothing here yet.
   */
  history: StoredUiMessage[];
  /**
   * Called when a run says what the conversation is called now. The server
   * names a conversation from its first message and says so on the stream.
   */
  onTitled: (title: string | null) => void;
}

/** The chunk the server names a conversation on. */
const TITLED = 'data-conversation-titled';

/** The chunk the server says a run stopped to fold memory on. */
const CONSOLIDATING = 'data-memory-consolidating';

/** The chunk the server names a questionnaire a message closed on (inner#1542). */
const ASK_REPLIED = 'data-ask-replied';

/** The chunk a run says it took a waiting message in on (inner#1717). */
const USER_MESSAGE = 'data-user-message';

/** The chunk a run says, before its end, that the next run is already open (inner#1717). */
const NEXT_RUN = 'data-next-run';

/** The chunk the server proves a running stream alive with. */
const BEAT = 'data-heartbeat';

/** The chunk a run's stream names its run with, after its first beat (inner#1717). */
const RUN = 'data-run';

/**
 * What a card's call ends with: a questionnaire's result, or a request to
 * look at Spaces settled as the server stored it (inner#1552).
 */
export type CardResult = AskUserResult | Record<string, unknown>;

/** Every conversation whose state is being kept, by conversation id. */
const sessions = new Map<string, Chat<StoredUiMessage>>();

/**
 * What a panel subscribes to before it knows which conversation it is showing.
 *
 * A hook cannot be called conditionally, so a panel opening a project has to
 * subscribe to something during the round trip that tells it which
 * conversation that is. This one is empty and stays empty.
 */
const NOTHING_OPEN = new Chat<StoredUiMessage>({ id: 'no-conversation-yet', messages: [] });

/**
 * Whether this frame is one the user will see something of: a transient data
 * part is handed to `onData` and dropped there (`ai@7.0.68` `index.js:7416`),
 * so it never becomes part of the answer.
 * @param chunk - One frame off the wire.
 * @returns True when this frame is part of the answer.
 */
function isAnswering(chunk: UIMessageChunk): boolean {
  return !(chunk.type.startsWith('data-') && 'transient' in chunk && chunk.transient === true);
}

/**
 * Tell on every frame of the answer, and pass every frame along untouched.
 *
 * Every frame rather than the first: a run names the conversation first and
 * only then stops to fold, so the line saying it folds has to be cleared by
 * whichever answering frame comes after it.
 * @param stream - The run's stream.
 * @param onAnswering - Told on every frame that carries an answer.
 * @returns The same frames, in the same order.
 */
function sayWhenItAnswers(stream: ReadableStream<UIMessageChunk>, onAnswering: () => void): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (isAnswering(chunk)) onAnswering();
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Keep every message under the name this end gave it.
 *
 * The server names each reply it streams on its `start` frame, a name this
 * end never gave out. `Chat` replaces the last message only while the reply's
 * id matches it and pushes a new one otherwise (`ai@7.0.68` `index.js:17977`),
 * so a renamed `start` adds a second copy of the reply so far. Without a name
 * on `start` the SDK keeps the one the stream began under (`index.js:7368`).
 * @param stream - A run's stream.
 * @returns The same frames, `start` without a name.
 */
function keepOurNames(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk> {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start' && chunk.messageId !== undefined) {
          const { messageId: _named, ...rest } = chunk;
          controller.enqueue(rest);
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * The transport a conversation's runs are read on. Nothing is sent through
 * it: a message goes out as a request of its own (`stores/chat-live`), and
 * what the run says arrives only by attaching. Every run writes a reply of its
 * own, a run resumed after a card included: the server stores it as its own
 * row after the reply that asked.
 * @param conversationId - The conversation.
 * @returns The transport.
 */
function transportFor(conversationId: string): ChatTransport<StoredUiMessage> {
  const wire = new DefaultChatTransport<StoredUiMessage>({
    api: chatApi.streamPath(conversationId),
    // The session cookie says who is asking, and a cross-origin default would
    // leave it off wherever the API is not the page's own origin.
    credentials: 'include',
    prepareReconnectToStreamRequest: () => ({
      api: chatApi.streamPath(conversationId),
      credentials: 'include',
      // What the interface is in, as every other request this app makes says.
      headers: { 'Accept-Language': getLocale() },
    }),
  });
  return {
    sendMessages: () => Promise.reject(new Error('A message is sent by stores/chat-live, not through the transport.')),
    reconnectToStream: async (options) => {
      const stream = await wire.reconnectToStream(options);
      if (stream === null) return null;
      streamOpened.get(conversationId)?.();
      return sayWhenItAnswers(keepOurNames(stream), () => clearConsolidating(conversationId));
    },
  };
}

/** The wait for the next beat of each run being read, by conversation id. */
const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

/** The runs whose beats stopped coming while they were read. */
const lost = new Set<string>();

/** The runs this page is letting go of on purpose (switching away, leaving). */
const lettingGo = new Set<string>();

/** The runs that said, before ending, that the next run is already open. */
const nextRunSaid = new Set<string>();

/** The run each conversation's stream last named, which a stop pressed here means. */
const runNamed = new Map<string, string>();

/** The conversations this page is reading a run of now. */
const reading = new Set<string>();

/** Told, per conversation being read, once the server handed over a run's stream. */
const streamOpened: Map<string, () => void> = new Map();

/**
 * Stop waiting on a run's beats.
 * @param conversationId - The conversation.
 */
function stopWatching(conversationId: string): void {
  const waiting = watchdogs.get(conversationId);
  if (waiting !== undefined) clearTimeout(waiting);
  watchdogs.delete(conversationId);
}

/**
 * Wait for the next beat of a run being read, counting from now; when none
 * comes in time, the server that runs it is gone, and the read is let go.
 * @param conversationId - The conversation.
 */
async function expectAnotherBeat(conversationId: string): Promise<void> {
  let heartbeatIntervalMs: number;
  try {
    ({ heartbeatIntervalMs } = await chatApi.streamConfig());
  } catch (failed) {
    // Nothing for the user to do about a request they did not make. What it
    // costs is this read going unwatched, so it is written down.
    console.error('[chat] the run is read unwatched: no stream config', failed);
    return;
  }
  if (!reading.has(conversationId)) return;
  stopWatching(conversationId);
  watchdogs.set(
    conversationId,
    setTimeout(() => {
      watchdogs.delete(conversationId);
      lost.add(conversationId);
      void sessions.get(conversationId)?.stop();
    }, heartbeatIntervalMs * SSE_HEARTBEAT_MISSES_ALLOWED),
  );
}

/**
 * Write a card call's result into whichever message holds the call.
 * @param chat - The session.
 * @param toolCallId - The call.
 * @param result - What it ended with.
 */
function settleAskIn(chat: Chat<StoredUiMessage>, toolCallId: string, result: CardResult): void {
  const at = chat.messages.findIndex((m) =>
    m.parts.some((p) => (p as { toolCallId?: unknown }).toolCallId === toolCallId),
  );
  const message = chat.messages[at];
  if (message === undefined) return;
  const parts = message.parts.map((p) =>
    (p as { toolCallId?: unknown }).toolCallId === toolCallId
      ? ({ ...p, state: 'output-available', output: result } as unknown as typeof p)
      : p,
  );
  chat.messages = chat.messages.map((m, i) => (i === at ? { ...message, parts } : m));
}

/**
 * Draw a card as the server says its call stands.
 * @param conversationId - The conversation.
 * @param toolCallId - The call.
 * @param result - What it ended with.
 */
export function settleAsk(conversationId: string, toolCallId: string, result: CardResult): void {
  const chat = sessions.get(conversationId);
  if (chat) settleAskIn(chat, toolCallId, result);
}

/**
 * The turn a stored message belongs to.
 * @param message - The message.
 * @returns Its turn, or undefined for one drawn here and not read back.
 */
function turnOf(message: StoredUiMessage): number | undefined {
  return message.metadata?.turnIndex;
}

/**
 * Lay the newest page of a conversation's history over its list.
 *
 * Where the page joins the list -- the list holds a turn no earlier than the
 * page's first -- the list is kept up to that turn and the page replaces the
 * rest, so what "load earlier" brought up stays. Where it does not, the page
 * replaces the list whole, and the caller is told so it can take the page's
 * reach as the list's (`hasMore`, the oldest turn).
 * @param conversationId - The conversation.
 * @param page - The newest page, oldest first.
 * @returns `joined` when the page was laid over the list, `replaced` when it took its place.
 */
export function layLatestPage(conversationId: string, page: StoredUiMessage[]): 'joined' | 'replaced' {
  const chat = sessions.get(conversationId);
  if (!chat) return 'replaced';
  const first = page.map(turnOf).find((turn) => turn !== undefined);
  const kept = first === undefined ? [] : chat.messages.filter((m) => (turnOf(m) ?? Infinity) < first);
  const joins = first !== undefined && chat.messages.some((m) => (turnOf(m) ?? -Infinity) >= first);
  chat.messages = joins ? [...kept, ...page] : page;
  return joins ? 'joined' : 'replaced';
}

/** How reading a run ended. */
export type RunRead =
  /** No run held the conversation by the time the stream was asked for. */
  | 'none'
  /** The run ended, however it did. */
  | 'ended'
  /** The run ended and said the next one is already open. */
  | 'next'
  /** The run's beats stopped coming. */
  | 'lost'
  /** The connection broke while it was read. */
  | 'broken'
  /** This page let go of it. */
  | 'let-go';

/**
 * Read the run that holds a conversation, from its start, until it ends.
 *
 * The history page the run joins onto is laid over the list first, by the
 * caller (`layLatestPage`). Resolves once the stream is over; `onOpened` is
 * told once a stream exists to read.
 * @param conversationId - The conversation.
 * @param onOpened - Told when there is a run's stream to read.
 * @returns How the read ended.
 */
export async function readRun(conversationId: string, onOpened: () => void): Promise<RunRead> {
  const chat = sessions.get(conversationId);
  if (!chat || reading.has(conversationId)) return 'none';
  reading.add(conversationId);
  lost.delete(conversationId);
  lettingGo.delete(conversationId);
  nextRunSaid.delete(conversationId);
  let opened = false;
  streamOpened.set(conversationId, () => {
    opened = true;
    void expectAnotherBeat(conversationId);
    onOpened();
  });
  try {
    await chat.resumeStream();
  } finally {
    streamOpened.delete(conversationId);
    reading.delete(conversationId);
    stopWatching(conversationId);
    clearConsolidating(conversationId);
    noteTurnSettled(conversationId);
    // The run read is over unless it handed over: a stop pressed before the
    // next stream names its run means whichever run holds the conversation.
    if (!nextRunSaid.has(conversationId)) runNamed.delete(conversationId);
  }
  if (lettingGo.delete(conversationId)) return 'let-go';
  if (lost.delete(conversationId)) return 'lost';
  if (!opened) return 'none';
  if (chat.status === 'error') {
    const broke = chat.error instanceof TypeError;
    if (broke) return 'broken';
  }
  return nextRunSaid.delete(conversationId) ? 'next' : 'ended';
}

/**
 * The run a conversation's stream last named.
 * @param conversationId - The conversation.
 * @returns Its id, or undefined before a stream named one.
 */
export function runNamedIn(conversationId: string): string | undefined {
  return runNamed.get(conversationId);
}

/**
 * Whether this page is reading a conversation's run now.
 * @param conversationId - The conversation.
 * @returns True while it is.
 */
export function isReadingRun(conversationId: string): boolean {
  return reading.has(conversationId);
}

/**
 * Stop reading a conversation's run without stopping the run: it goes on on
 * the server, and reading it again later replays it from its start.
 * @param conversationId - The conversation.
 */
export function letGoOfRun(conversationId: string): void {
  if (!reading.has(conversationId)) return;
  lettingGo.add(conversationId);
  void sessions.get(conversationId)?.stop();
}

/**
 * Whether the run being read ended in an error the server reported.
 * @param conversationId - The conversation.
 * @returns True when its last read ended in an error.
 */
export function runEndedInError(conversationId: string): boolean {
  return sessions.get(conversationId)?.status === 'error';
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

  const { conversationId, onTitled } = init;
  const chat = new Chat<StoredUiMessage>({
    id: conversationId,
    messages: init.history,
    transport: transportFor(conversationId),
    onData: (part) => {
      if (part.type === BEAT) {
        if (reading.has(conversationId)) void expectAnotherBeat(conversationId);
        return;
      }
      if (part.type === CONSOLIDATING) {
        noteConsolidating(conversationId);
        return;
      }
      if (part.type === RUN || part.type === NEXT_RUN) {
        const runId = (part.data as { runId?: unknown } | null)?.runId;
        if (typeof runId === 'string') runNamed.set(conversationId, runId);
        if (part.type === NEXT_RUN) nextRunSaid.add(conversationId);
        return;
      }
      if (part.type === USER_MESSAGE) {
        const id = (part.data as { id?: unknown } | null)?.id;
        if (typeof id === 'string') chatWaiting.remove(conversationId, id);
        return;
      }
      if (part.type === ASK_REPLIED) {
        const id = (part.data as { toolCallId?: unknown } | null)?.toolCallId;
        if (typeof id === 'string') settleAskIn(chat, id, { repliedInChat: true });
        return;
      }
      if (part.type !== TITLED) return;
      const { title } = part.data as { title: string | null };
      onTitled(title);
    },
  });
  sessions.set(conversationId, chat);
  return chat;
}

/**
 * Whether this conversation's state is already being kept here.
 * @param conversationId - Which conversation.
 * @returns True when a session for it exists.
 */
export function hasChatSession(conversationId: string): boolean {
  return sessions.has(conversationId);
}

/**
 * Put a page of older messages at the head of a conversation's list. The head
 * is the half no run touches: a reply is appended to the tail.
 * @param conversationId - The conversation reaching further back.
 * @param earlier - The page, oldest first.
 */
export function prependHistory(conversationId: string, earlier: StoredUiMessage[]): void {
  const chat = sessions.get(conversationId);
  if (!chat) return;
  chat.messages = [...earlier, ...chat.messages];
}

/**
 * Drop one conversation's state, when the conversation itself is gone from
 * this page (deleted, or the project left). Its run, if it has one, goes on
 * or is stopped on the server; this page only stops reading it.
 * @param conversationId - Which one.
 */
export function evictChatSession(conversationId: string): void {
  letGoOfRun(conversationId);
  stopWatching(conversationId);
  sessions.delete(conversationId);
  reading.delete(conversationId);
  lost.delete(conversationId);
  nextRunSaid.delete(conversationId);
  runNamed.delete(conversationId);
  noteTurnSettled(conversationId);
  chatWaiting.forget(conversationId);
}

/** Drop every conversation's state, for leaving a project. */
export function evictAllChatSessions(): void {
  for (const id of [...reading]) letGoOfRun(id);
  for (const id of [...watchdogs.keys()]) stopWatching(id);
  sessions.clear();
  reading.clear();
  lost.clear();
  nextRunSaid.clear();
  runNamed.clear();
  clearRunningTurns();
  chatWaiting.clearAll();
}
