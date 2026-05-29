import * as React from 'react';

import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useChatStore } from '@web/stores';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import {
  ConversationHistorySheet,
  type ConversationSummary,
} from '@web/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@web/pages/project/chat/MessageList';
import type { ChatMessage } from '@web/pages/project/chat/types';

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
  /**
   * When `true`, the entire chat panel is rendered in a disabled state
   * (opacity + pointer-events:none). Per 2026-05-28 spec § 6.2 + 6.3,
   * viewers see the chat but cannot interact — the upgrade entry lives
   * on the top-bar RoleTag so no in-panel banner is needed.
   */
  disabled?: boolean;
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
  disabled = false,
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
      data-disabled={disabled ? 'true' : undefined}
      aria-disabled={disabled || undefined}
      className='flex h-full w-full flex-col'
      style={
        disabled
          ? { opacity: 0.5, pointerEvents: 'none' }
          : undefined
      }
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
