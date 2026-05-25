import * as React from 'react';

import { useExclusiveOverlay } from '@/lib/use-exclusive-overlay';
import { useChatStore } from '@/stores';

import { ChatComposer } from '@/pages/project/chat/ChatComposer';
import {
  ConversationHistorySheet,
  type ConversationSummary,
} from '@/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@/pages/project/chat/MessageList';
import type { ChatMessage } from '@/pages/project/chat/types';

interface ChatPanelProps {
  /** Project this chat belongs to — for the title bar / API scoping. */
  projectId: string;
  /** Static demo messages until real conversation loading is wired in. */
  initialMessages?: ReadonlyArray<ChatMessage>;
  conversations?: ReadonlyArray<ConversationSummary>;
  onSend?: (text: string) => void;
  onAbort?: () => void;
  /**
   * Called when the user picks a quick-action chip in the empty state.
   * Wiring loads the label into the composer draft so the user can edit
   * before sending; default behaviour just sets the draft.
   */
  onQuickAction?: (label: string) => void;
}

/**
 * Project ChatPanel — private per-user agent chat. Does NOT participate
 * in Yjs (memory `project_chat_private_no_yjs`).
 *
 * PR 9 wires UI structure + composer state to `useChatStore`; the SSE
 * stream + REST history loader hooks into the same store in a later PR.
 */
export function ChatPanel({
  projectId,
  initialMessages = [],
  conversations = [],
  onSend,
  onAbort,
  onQuickAction,
}: ChatPanelProps) {
  const draft = useChatStore((s) => s.composerDraft);
  const setDraft = useChatStore((s) => s.setComposerDraft);
  const clearDraft = useChatStore((s) => s.clearComposerDraft);
  const streaming = useChatStore((s) => s.streaming);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setActiveConversationId = useChatStore(
    (s) => s.setActiveConversationId,
  );

  const [historyOpen, setHistoryOpen] = useExclusiveOverlay('conversation-history');

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    onSend?.(trimmed);
    clearDraft();
  };

  return (
    <div
      data-testid='chat-panel'
      data-project-id={projectId}
      className='flex h-full w-full flex-col'
    >
      <MessageList
        messages={initialMessages}
        onQuickAction={(label) => {
          if (onQuickAction) onQuickAction(label);
          else setDraft(label);
        }}
      />
      <ChatComposer
        draft={draft}
        streaming={streaming}
        onChange={setDraft}
        onSubmit={submit}
        onAbort={onAbort}
      />
      <ConversationHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        conversations={conversations}
        activeId={activeConversationId ?? undefined}
        onPick={(id) => {
          setActiveConversationId(id);
          setHistoryOpen(false);
        }}
      />
    </div>
  );
}
