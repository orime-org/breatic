// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Chat composer + streaming store — per-user agent chat session UI state.
 *
 * Chat content is private and does NOT enter Yjs. This store holds the
 * composer draft, the current conversation id, and the SSE streaming flag.
 *
 * Where the messages themselves live is not settled here, on purpose. A line
 * at the foot of this comment used to answer it, written before there was
 * anything to hold — nothing renders a message from a server response today.
 * PR-3 batch 6 decides it, and it has to come out as one source: the reply
 * being streamed and the reply read back from the server are the same
 * message, and the screen must not show it twice or lose it at the handover.
 */
interface ChatState {
  composerDraft: string;
  activeConversationId: string | null;
  streaming: boolean;
  setComposerDraft: (draft: string) => void;
  clearComposerDraft: () => void;
  setActiveConversationId: (id: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  /** Reset per-project chat session state (draft / active conversation / streaming) on project change (#1771). */
  reset: () => void;
}

export const useChatStore = create<ChatState>()(
  immer((set) => ({
    composerDraft: '',
    activeConversationId: null,
    streaming: false,
    setComposerDraft: (draft) =>
      set((s) => {
        s.composerDraft = draft;
      }),
    clearComposerDraft: () =>
      set((s) => {
        s.composerDraft = '';
      }),
    setActiveConversationId: (id) =>
      set((s) => {
        s.activeConversationId = id;
      }),
    setStreaming: (streaming) =>
      set((s) => {
        s.streaming = streaming;
      }),
    reset: () =>
      set((s) => {
        s.composerDraft = '';
        s.activeConversationId = null;
        s.streaming = false;
      }),
  })),
);
