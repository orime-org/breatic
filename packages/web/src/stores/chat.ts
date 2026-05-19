import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**
 * Chat composer + streaming store — per-user agent chat session UI state.
 *
 * Per memory `project_chat_private_no_yjs`: chat content is private and
 * does NOT enter Yjs. This store holds the composer draft, current
 * conversation id, and SSE streaming flag.
 *
 * Message history itself lives in REST cache (React Query), not here.
 */
interface ChatState {
  composerDraft: string;
  activeConversationId: string | null;
  streaming: boolean;
  setComposerDraft: (draft: string) => void;
  clearComposerDraft: () => void;
  setActiveConversationId: (id: string | null) => void;
  setStreaming: (streaming: boolean) => void;
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
  })),
);
