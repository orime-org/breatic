// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which conversations have an Agent turn running on this page (#1394).
 *
 * `chat-sessions` knows, in a module-private map that nothing can subscribe
 * to; the conversation list needs to redraw when it changes. Its own store,
 * because the reader is a pages hook and `stores/` may not import from
 * `pages/`.
 * Written only by `chat-sessions`, read only by `useRunningConversations`.
 */

import { create } from 'zustand';

interface RunningTurnsState {
  /** Present and true while that conversation has a turn running here. */
  byConversation: Record<string, true>;
}

const useStore = create<RunningTurnsState>(() => ({ byConversation: {} }));

/** The store, for the hook that marks the conversation list. */
export const useRunningTurns = useStore;

/**
 * Record that a turn started in a conversation on this page.
 * @param conversationId - The conversation.
 */
export function noteTurnRunning(conversationId: string): void {
  useStore.setState((s) => {
    if (s.byConversation[conversationId]) return s;
    return { byConversation: { ...s.byConversation, [conversationId]: true as const } };
  });
}

/**
 * Record that a conversation's turn ended, however it ended.
 * @param conversationId - The conversation.
 */
export function noteTurnSettled(conversationId: string): void {
  useStore.setState((s) => {
    if (!s.byConversation[conversationId]) return s;
    const { [conversationId]: _done, ...rest } = s.byConversation;
    return { byConversation: rest };
  });
}

/** Forget every conversation, for leaving the project. */
export function clearRunningTurns(): void {
  useStore.setState({ byConversation: {} });
}
