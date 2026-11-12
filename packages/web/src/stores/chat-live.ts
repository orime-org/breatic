// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The conversation on screen, kept in step with the server (inner#1717).
 *
 * A run is the server's. This page follows it for the one conversation it is
 * showing: it asks where the conversation stands every few seconds (`sync`),
 * and whenever a run holds it -- a sync says so, a send opened or joined one,
 * a run said the next is open -- it reads the newest page of history and
 * attaches to the run's stream. When the stream ends, however it ends, it
 * asks again at once. A conversation not on screen holds no stream and is
 * not asked about; its run goes on on the server.
 */
import { create } from 'zustand';
import { newId } from '@breatic/shared';
import type { AskUserAnswer, ChatAttachedChip, ChatPendingItem, ChatSendAnswer, ChatSpaceContext, SpaceRequestAnswer } from '@breatic/shared';
import { chatApi } from '@web/data/api/chat';
import { bodyOrTransfer } from '@web/data/upload/transfer-body';
import { chatAttachments } from '@web/stores/chat-attachments';
import { readMishap, tell } from '@web/stores/chat-mishaps';
import { chatWaiting } from '@web/stores/chat-waiting';
import { conversationRuntime } from '@web/stores/conversation-runtime';
import { noteTurnRunning } from '@web/stores/running-turns';
import { runOnce } from '@web/stores/task-actions-in-flight';
import { ApiException } from '@web/data/api/types';
import { isReadingRun, layLatestPage, letGoOfRun, readRun, runEndedInError, settleAsk, type CardResult } from '@web/stores/chat-sessions';

/** The conversation this page shows, and its project. */
interface Showing {
  projectId: string;
  conversationId: string;
  /** The wait for the next sync, when one is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** How long to wait between syncs, as the server last said. */
  intervalMs: number | null;
  /** A sync is out. */
  syncing: boolean;
}

/** What the composer reads about the conversation on screen. */
interface ChatLiveState {
  /** A message is on its way, from the press until the server answered. */
  sending: Record<string, true>;
  /** A stop is on its way. */
  stopping: Record<string, true>;
}

export const useChatLive = create<ChatLiveState>(() => ({ sending: {}, stopping: {} }));

/** The one conversation shown, or null. */
let showing: Showing | null = null;

/** The attaches under way, by conversation, so one is never started twice. */
const attaching = new Map<string, Promise<void>>();

/**
 * Whether a conversation is the one on screen.
 * @param conversationId - The conversation.
 * @returns True while it is.
 */
function isShowing(conversationId: string): boolean {
  return showing?.conversationId === conversationId;
}

/**
 * Whether the tab is in view; a hidden tab asks the server nothing.
 * @returns True when it is.
 */
function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Wait for the next sync of the conversation on screen.
 * @param shown - What is shown.
 */
function scheduleSync(shown: Showing): void {
  if (shown.timer !== null) clearTimeout(shown.timer);
  shown.timer = null;
  if (showing !== shown || !tabVisible() || shown.intervalMs === null) return;
  shown.timer = setTimeout(() => {
    shown.timer = null;
    void syncNow(shown.conversationId);
  }, shown.intervalMs);
}

/**
 * Ask where the conversation on screen stands, and act on the answer: the
 * waiting area takes what the server holds, and a run that holds it is
 * attached to.
 * @param conversationId - The conversation.
 */
async function syncNow(conversationId: string): Promise<void> {
  const shown = showing;
  if (shown?.conversationId !== conversationId || shown.syncing || !tabVisible()) return;
  shown.syncing = true;
  if (shown.timer !== null) clearTimeout(shown.timer);
  shown.timer = null;
  try {
    if (shown.intervalMs === null) {
      shown.intervalMs = (await chatApi.streamConfig().catch(() => null))?.syncIntervalMs ?? null;
    }
    const seen = await chatApi.sync(conversationId, shown.projectId);
    if (showing !== shown) return;
    shown.intervalMs = seen.next_sync_ms;
    chatWaiting.fromSync(conversationId, { pending: seen.pending, awaiting: seen.awaiting, blocked: seen.blocked === 'credits' });
    if (seen.running && !isReadingRun(conversationId)) void attach(conversationId);
  } catch (err) {
    // Asked again at the next interval; a sync that does not land changes
    // nothing on screen, so there is nothing to tell.
    console.error('[chat] a sync did not land', err);
  } finally {
    shown.syncing = false;
    scheduleSync(shown);
  }
}

/**
 * Read the newest page of a conversation's history and attach to the run
 * that holds it, following it into the next run and back after a lost
 * connection, and sync once it is over.
 * @param conversationId - The conversation.
 * @returns When reading is over.
 */
function attach(conversationId: string): Promise<void> {
  const under = attaching.get(conversationId);
  if (under) return under;
  const run = (async (): Promise<void> => {
    for (;;) {
      if (!isShowing(conversationId) || isReadingRun(conversationId)) return;
      let read;
      try {
        read = await chatApi.readConversation(conversationId);
      } catch (err) {
        // The next sync asks again.
        console.error('[chat] the history before a run did not land', err);
        return;
      }
      if (!isShowing(conversationId)) return;
      if (layLatestPage(conversationId, read.messages) === 'replaced') conversationRuntime.tookLatestPage(conversationId, read);
      const ended = await readRun(conversationId, () => noteTurnRunning(conversationId));
      if (ended === 'let-go') return;
      if (ended === 'next') continue;
      if (ended === 'lost' || ended === 'broken') {
        tell({ projectId: showing?.projectId ?? '', conversationId, kind: 'network' });
        continue;
      }
      if (ended === 'ended' && runEndedInError(conversationId)) {
        tell({ projectId: showing?.projectId ?? '', conversationId, kind: 'turn' });
      }
      break;
    }
  })().finally(() => {
    attaching.delete(conversationId);
  });
  attaching.set(conversationId, run);
  // Once a stream is over, however it ended, ask where things stand: a run may
  // have opened for what waits, here or on another server.
  void run.then(() => syncNow(conversationId));
  return run;
}

/** What a message is sent with. */
export interface Sending {
  projectId: string;
  conversationId: string;
  /** What the user typed, trimmed. */
  words: string;
  /** What is attached, carried ahead of the words. */
  chips: readonly ChatAttachedChip[];
  /** The user's Spaces, read at the press. */
  spaces: ChatSpaceContext;
  /** The model the conversation is answered by, as the picker last set it (#1363). */
  model?: string;
}

/** How a send ended: answered, refused, or let go with no answer to act on. */
export type SendOutcome = 'sent' | 'refused' | 'unknown';

/** The sends of each conversation, chained so one goes once the one before was answered. */
const sendChains = new Map<string, Promise<unknown>>();

/**
 * Mark a conversation as sending, or not.
 * @param conversationId - The conversation.
 * @param on - Whether a send is on its way.
 */
function markSending(conversationId: string, on: boolean): void {
  useChatLive.setState((s) => {
    const { [conversationId]: _was, ...rest } = s.sending;
    return { sending: on ? { ...rest, [conversationId]: true as const } : rest };
  });
}

/**
 * Send one message and act on the answer.
 * @param sending - What is sent, and where.
 * @returns How it ended.
 */
async function sendOne(sending: Sending): Promise<SendOutcome> {
  const { projectId, conversationId, words, chips, spaces, model } = sending;
  // Made at the press and carried by every re-send, so the server takes the
  // message once however often it arrives (inner#1717).
  const id = newId();
  markSending(conversationId, true);
  try {
    const outcome = await runOnce<object, ChatSendAnswer>(`chat-send:${conversationId}:${id}`, {
      scope: 'conversation',
      prepare: () =>
        bodyOrTransfer(projectId, {
          ...spaces,
          id,
          message: words,
          project_id: projectId,
          conversation_id: conversationId,
          attached_chips: chips,
          // Read at each send: the agent is told the time where the user is now.
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(model === undefined ? {} : { model }),
        }),
      send: (key, body) => chatApi.sendMessage(body, key),
      onDone: (answer) => {
        // The server holds the message now, so it leaves the box, and the
        // items it carried leave with it (an item attached after the press is
        // for the next message).
        conversationRuntime.setDraft(conversationId, '');
        chatAttachments.removeSent(conversationId, chips);
        chatWaiting.fromSend(conversationId, answer.pending);
        if (answer.running && isShowing(conversationId) && !isReadingRun(conversationId)) void attach(conversationId);
        return undefined;
      },
      onFailure: (err) => {
        // The words stay in the box; the model picker asks again in case the
        // refusal was about the model (#1363).
        conversationRuntime.askModelListAgain();
        tell({ projectId, conversationId, ...readMishap(err) });
      },
    });
    return outcome.kind === 'done' ? 'sent' : outcome.kind === 'failed' ? 'refused' : 'unknown';
  } finally {
    markSending(conversationId, false);
  }
}

/** What answering a card sends. */
export interface Answering {
  projectId: string;
  conversationId: string;
  toolCallId: string;
  /** The answer, under the key the route reads it from. */
  card: { answer: AskUserAnswer } | { shared_spaces: SpaceRequestAnswer };
  /** The user's Spaces, read at the press. */
  spaces: ChatSpaceContext;
}

/**
 * How the server says a card's call already stands, when it refused an answer
 * because the call was answered (409 with the call in the error envelope).
 * @param err - What the request failed with.
 * @returns The call's result, when it ended in success.
 */
function callAlreadyAnswered(err: unknown): CardResult | undefined {
  if (!(err instanceof ApiException) || err.status !== 409) return undefined;
  const call = err.details?.call as { status?: unknown; output?: unknown } | undefined;
  return call?.status === 'success' ? (call.output as CardResult) : undefined;
}

/**
 * Change a flag kept per conversation.
 * @param key - Which flag.
 * @param conversationId - The conversation.
 * @param on - Set or cleared.
 */
function markFlag(key: 'stopping', conversationId: string, on: boolean): void {
  useChatLive.setState((s) => {
    const { [conversationId]: _was, ...rest } = s[key];
    return { [key]: on ? { ...rest, [conversationId]: true as const } : rest };
  });
}

/**
 * Asked when the tab is shown or hidden: a hidden tab stops syncing, and one
 * shown again asks at once.
 */
function onVisibility(): void {
  if (showing === null) return;
  if (tabVisible()) void syncNow(showing.conversationId);
  else scheduleSync(showing);
}

export const chatLive = {
  /**
   * Send a message to a conversation, once the one this page sent before it
   * was answered.
   * @param sending - What is sent, and where.
   * @returns How it ended.
   */
  send(sending: Sending): Promise<SendOutcome> {
    const before = sendChains.get(sending.conversationId) ?? Promise.resolve();
    const mine = before.then(() => sendOne(sending));
    const chained = mine.catch(() => undefined);
    sendChains.set(sending.conversationId, chained);
    void chained.then(() => {
      if (sendChains.get(sending.conversationId) === chained) sendChains.delete(sending.conversationId);
    });
    return mine;
  },
  /**
   * Answer the card a conversation's run stopped at; the run it resumes is
   * attached to, and the card is drawn as the server says it stands.
   * @param answering - The answer, and where.
   * @returns When the answer is settled one way or the other.
   */
  async answerCard(answering: Answering): Promise<void> {
    const { projectId, conversationId, toolCallId, card, spaces } = answering;
    try {
      const body = await bodyOrTransfer(projectId, {
        ...spaces,
        ...card,
        message: '',
        project_id: projectId,
        conversation_id: conversationId,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const answered = await chatApi.sendMessage(body, newId());
      if (answered.running) {
        if (isShowing(conversationId) && !isReadingRun(conversationId)) void attach(conversationId);
        return;
      }
      // The run ended before it ran (a shutdown): what it left is in the history.
      const read = await chatApi.readConversation(conversationId);
      if (layLatestPage(conversationId, read.messages) === 'replaced') conversationRuntime.tookLatestPage(conversationId, read);
    } catch (err) {
      const stands = callAlreadyAnswered(err);
      if (stands !== undefined) {
        settleAsk(conversationId, toolCallId, stands);
        return;
      }
      tell({ projectId, conversationId, ...readMishap(err) });
    }
  },
  /**
   * Stop the run that holds a conversation. The stream goes on to its end,
   * where the server writes that it was stopped.
   * @param projectId - Its project.
   * @param conversationId - The conversation.
   * @returns When the server answered.
   */
  async stop(projectId: string, conversationId: string): Promise<void> {
    markFlag('stopping', conversationId, true);
    try {
      await chatApi.stop(conversationId, projectId);
    } catch (err) {
      tell({ projectId, conversationId, ...readMishap(err) });
    } finally {
      markFlag('stopping', conversationId, false);
    }
  },
  /**
   * Take a waiting message back: into the box, or away.
   * @param projectId - Its project.
   * @param conversationId - The conversation.
   * @param item - The message.
   * @param how - Back into the box, or deleted.
   * @returns When the server answered.
   */
  async takeBack(projectId: string, conversationId: string, item: ChatPendingItem, how: 'retract' | 'delete'): Promise<void> {
    chatWaiting.busy(conversationId, item.id, how);
    try {
      const status = await chatApi.removeQueued(conversationId, item.id, projectId);
      // Taken: a run has it, and it shows in the reply soon.
      if (status === 'taken') return;
      chatWaiting.drop(conversationId, item.id);
      // Gone: another page took it back first, so it is not this page's to put back.
      if (status !== 'removed' || how !== 'retract') return;
      const draft = conversationRuntime.draftOf(conversationId);
      conversationRuntime.setDraft(conversationId, draft === '' ? item.words : `${item.words}\n${draft}`);
      if (item.chips.length > 0) {
        const config = await chatApi.streamConfig().catch(() => null);
        chatAttachments.add(
          conversationId,
          item.chips.map((chip) => ({ id: chip.id, name: chip.name, type: chip.type, status: 'ready' as const, chip })),
          { maxItems: config?.attachmentMaxItems ?? Infinity, maxChars: config?.attachmentMaxChars ?? Infinity },
        );
      }
    } catch (err) {
      tell({ projectId, conversationId, ...readMishap(err) });
    } finally {
      chatWaiting.busy(conversationId, item.id, undefined);
    }
  },
  /**
   * Show a conversation: sync it at once and every interval after, attaching
   * to whatever run holds it.
   * @param projectId - Its project.
   * @param conversationId - The conversation.
   */
  show(projectId: string, conversationId: string): void {
    if (showing?.conversationId === conversationId) return;
    if (showing !== null) chatLive.hide(showing.conversationId);
    showing = { projectId, conversationId, timer: null, intervalMs: null, syncing: false };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    void syncNow(conversationId);
  },
  /**
   * Stop showing a conversation: no more syncs, and its stream is let go of.
   * Its run goes on on the server.
   * @param conversationId - The conversation.
   */
  hide(conversationId: string): void {
    if (showing?.conversationId !== conversationId) return;
    if (showing.timer !== null) clearTimeout(showing.timer);
    showing = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    letGoOfRun(conversationId);
  },
};

/** Forget everything between test cases. */
export function resetChatLiveForTests(): void {
  if (showing !== null) chatLive.hide(showing.conversationId);
  attaching.clear();
  sendChains.clear();
  useChatLive.setState({ sending: {}, stopping: {} });
}
