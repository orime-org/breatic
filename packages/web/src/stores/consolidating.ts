// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which conversations are folding memory before they answer.
 *
 * One fact, held apart from both stores that touch it. The turn's stream is
 * what learns of it — `chat-sessions` reads the wire — and the panel is what
 * shows it, which is `conversation-runtime`'s side of the app. Kept inside
 * either one, the other has to import it, and the two already import each
 * other's session bookkeeping.
 */

import { create } from 'zustand';

interface ConsolidatingState {
  /** Present and true while that conversation's turn is folding. */
  byConversation: Record<string, true>;
}

const useStore = create<ConsolidatingState>(() => ({ byConversation: {} }));

/** The store, for components that watch one conversation. */
export const useConsolidating = useStore;

/**
 * Record that a conversation is folding memory before it answers.
 * @param conversationId - The conversation the word came in on.
 */
export function noteConsolidating(conversationId: string): void {
  useStore.setState((s) => ({
    byConversation: { ...s.byConversation, [conversationId]: true as const },
  }));
}

/**
 * Take the word back down.
 *
 * Called when the reply starts and when the turn ends however it ended. A
 * fold that failed, a model that errored and a reader who pressed stop all
 * leave the same thing behind otherwise: a line about the previous turn,
 * still on screen the next time this conversation is opened.
 * @param conversationId - The conversation to clear.
 */
export function clearConsolidating(conversationId: string): void {
  useStore.setState((s) => {
    if (!s.byConversation[conversationId]) return s;
    const { [conversationId]: _done, ...rest } = s.byConversation;
    return { byConversation: rest };
  });
}

/** Forget every conversation, for the runtime's own reset. */
export function forgetAllConsolidating(): void {
  useStore.setState({ byConversation: {} });
}
