// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The waiting area of each conversation (inner#1717).
 *
 * What it shows is the server's queue: the messages sent that no run has read
 * yet, as the last answer that carried them said (a send, a sync, taking one
 * back). Every page looking at the conversation shows the same list, because
 * every page reads it from the same place. A message leaves it when a run
 * takes it in (`data-user-message` on the stream) or when it is taken back.
 */
import { create } from 'zustand';
import type { ChatPendingItem } from '@breatic/shared';

/** What one conversation's waiting area holds. */
export interface WaitingArea {
  pending: ChatPendingItem[];
  /** A card waits for the user's answer, and what waits goes after it. */
  awaiting: boolean;
  /** What waits could not open a run, because the balance cannot pay. */
  blocked: boolean;
  /** Which messages are being taken back, and whether into the box or away. */
  busy: Record<string, 'retract' | 'delete'>;
}

interface ChatWaitingState {
  byConversation: Record<string, WaitingArea>;
}

/** Nothing waiting, and no reason given. */
const EMPTY: WaitingArea = { pending: [], awaiting: false, blocked: false, busy: {} };

export const useChatWaiting = create<ChatWaitingState>(() => ({ byConversation: {} }));

/**
 * Change one conversation's waiting area.
 * @param conversationId - The conversation.
 * @param change - What changes, given the area as it stands.
 */
function update(conversationId: string, change: (area: WaitingArea) => Partial<WaitingArea>): void {
  useChatWaiting.setState((s) => {
    const area = s.byConversation[conversationId] ?? EMPTY;
    return { byConversation: { ...s.byConversation, [conversationId]: { ...area, ...change(area) } } };
  });
}

export const chatWaiting = {
  /**
   * What a send answered: the queue as it now stands. A send is the server
   * taking the message in, so neither reason to wait holds any longer.
   * @param conversationId - The conversation.
   * @param pending - The queue.
   */
  fromSend(conversationId: string, pending: ChatPendingItem[]): void {
    update(conversationId, () => ({ pending, awaiting: false, blocked: false }));
  },
  /**
   * What a sync answered.
   * @param conversationId - The conversation.
   * @param seen - The queue, and why it waits.
   * @param seen.pending - The queue.
   * @param seen.awaiting - A card waits.
   * @param seen.blocked - The balance cannot pay for a run.
   */
  fromSync(conversationId: string, seen: { pending: ChatPendingItem[]; awaiting: boolean; blocked: boolean }): void {
    update(conversationId, () => seen);
  },
  /**
   * A run took a message in.
   * @param conversationId - The conversation.
   * @param id - The message.
   */
  taken(conversationId: string, id: string): void {
    update(conversationId, (area) => ({ pending: area.pending.filter((p) => p.id !== id) }));
  },
  /**
   * A message was taken back, here or elsewhere.
   * @param conversationId - The conversation.
   * @param id - The message.
   */
  drop(conversationId: string, id: string): void {
    update(conversationId, (area) => ({ pending: area.pending.filter((p) => p.id !== id) }));
  },
  /**
   * Mark a message as being taken back, or clear the mark.
   * @param conversationId - The conversation.
   * @param id - The message.
   * @param how - Into the box or away; undefined once the answer came.
   */
  busy(conversationId: string, id: string, how: 'retract' | 'delete' | undefined): void {
    update(conversationId, (area) => {
      const { [id]: _was, ...rest } = area.busy;
      return { busy: how === undefined ? rest : { ...rest, [id]: how } };
    });
  },
  /**
   * Forget a conversation's waiting area, once it is gone from this page.
   * @param conversationId - The conversation.
   */
  forget(conversationId: string): void {
    useChatWaiting.setState((s) => {
      const { [conversationId]: _gone, ...rest } = s.byConversation;
      return { byConversation: rest };
    });
  },
  /** Forget every conversation's, when the project is left. */
  clearAll(): void {
    useChatWaiting.setState({ byConversation: {} });
  },
};
