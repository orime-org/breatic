// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useChatStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';

import { StreamRefusedError } from '@web/data/stream/sse';
import { toast } from '@web/lib/toast';
import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import {
  ConversationHistorySheet,
  type ConversationSummary,
} from '@web/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@web/pages/project/chat/MessageList';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';

interface ChatPanelProps {
  /** Project this chat belongs to — the chat is opened against it. */
  projectId: string;
  conversations?: ReadonlyArray<ConversationSummary>;
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
 * The messages, and sending and stopping, all come from one hook so that the
 * history and the reply being streamed are never two different lists.
 * @param root0 - The component props.
 * @param root0.projectId - The project this chat belongs to.
 * @param root0.conversations - The conversation summaries shown in the history sheet.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @param root0.disabled - When true, renders the panel disabled (viewers cannot interact).
 * @returns The per-user private chat column with message list, composer, and history sheet.
 */
export function ChatPanel({
  projectId,
  conversations = [],
  onQuickAction,
  disabled = false,
}: ChatPanelProps): React.JSX.Element {
  const { messages, isPending, failedToOpen, canSend, send, abort } = useChatSession(projectId);
  const t = useTranslation();
  const draft = useChatStore((s) => s.composerDraft);
  const setDraft = useChatStore((s) => s.setComposerDraft);
  const clearDraft = useChatStore((s) => s.clearComposerDraft);
  const streaming = useChatStore((s) => s.streaming);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setActiveConversationId = useChatStore(
    (s) => s.setActiveConversationId,
  );

  const [historyOpen, setHistoryOpen] = useExclusiveOverlay('conversation-history');

  /**
   * Send the trimmed composer draft and clear the input.
   */
  const submit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    // Cleared here rather than when the reply ends. The composer is only live
    // when there is a conversation to write to, so by the time this runs the
    // message is already in the list — waiting for the whole turn would leave
    // the user's words sitting in the box beside their own sent bubble, and
    // wipe anything typed while the reply streamed in.
    void send(trimmed).catch((err: unknown) => {
      // The server said why, in the reader's language — sse.ts goes to the
      // trouble of reading that out of the error envelope, and this is the
      // only place it can reach a person.
      if (err instanceof StreamRefusedError) toast.error(err.message);
      // It was not sent, and the server kept no record of it — so nothing of
      // the attempt is on screen to explain itself. Handing the words back is
      // the explanation: the message is where the user left it, ready to send
      // again, rather than gone with nothing to show for it.
      setDraft(trimmed);
    });
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
      {failedToOpen ? (
        <div
          role='alert'
          data-testid='chat-open-failed'
          className='m-2.5 rounded-content-sm border border-status-error-border bg-status-error-bg px-3 py-2 text-xs text-status-error-foreground'
        >
          {t('chat.error.openFailed')}
        </div>
      ) : null}
      <MessageList
        messages={messages}
        loading={isPending || failedToOpen}
        onQuickAction={(label) => {
          if (onQuickAction) onQuickAction(label);
          else setDraft(label);
        }}
      />
      <ChatComposer
        draft={draft}
        streaming={streaming}
        disabled={!canSend}
        onChange={setDraft}
        onSubmit={submit}
        onAbort={abort}
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
