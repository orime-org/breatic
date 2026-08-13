// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * What the chat panel itself is doing — the composer draft and which
 * conversation is selected.
 *
 * Chat content is private and does NOT enter Yjs.
 *
 * What is happening in a conversation is not here: the messages and the turn
 * being run belong to the conversation and live in
 * `stores/conversation-runtime`. A boolean saying a reply was streaming used
 * to sit here as well, alongside two refs in the panel that said the same
 * thing, and the three had to be kept in step by hand. The conversation now
 * either has a turn or does not, which is one fact in one place.
 */
interface ChatState {
  composerDraft: string;
  activeConversationId: string | null;
  setComposerDraft: (draft: string) => void;
  clearComposerDraft: () => void;
  setActiveConversationId: (id: string | null) => void;
  /** Reset per-project chat session state (draft / active conversation) on project change (#1771). */
  reset: () => void;
}

export const useChatStore = create<ChatState>()(
  immer((set) => ({
    composerDraft: '',
    activeConversationId: null,
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
    reset: () =>
      set((s) => {
        s.composerDraft = '';
        s.activeConversationId = null;
      }),
  })),
);
