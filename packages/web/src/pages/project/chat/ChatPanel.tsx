// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useChatStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { ChatNotice } from '@web/pages/project/chat/ChatNotice';
import {
  ConversationHistorySheet,
  type ConversationSummary,
} from '@web/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@web/pages/project/chat/MessageList';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';

/**
 * What the history sheet is given before there is anything to give it.
 *
 * Module-level, because a default written at the parameter builds a new array
 * on every render -- and a new array is a changed prop, so the sheet would be
 * rendered again for every piece of a streaming reply.
 */
const NO_CONVERSATIONS: ReadonlyArray<ConversationSummary> = [];

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
  conversations = NO_CONVERSATIONS,
  onQuickAction,
  disabled = false,
}: ChatPanelProps): React.JSX.Element {
  const {
    messages,
    isPending,
    turnPhase,
    hasMore,
    mishap,
    loadEarlier,
    send,
    abort,
  } = useChatSession(projectId);
  const t = useTranslation();
  const draft = useChatStore((s) => s.composerDraft);
  const setDraft = useChatStore((s) => s.setComposerDraft);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setActiveConversationId = useChatStore(
    (s) => s.setActiveConversationId,
  );

  const [historyOpen, setHistoryOpen] = useExclusiveOverlay('conversation-history');
  // Sending is something the reader does, and this is where they do it. The
  // message list needs to know it happened — it is the one thing that should
  // bring the column back to the bottom after they have scrolled up to read.
  const [sentCount, setSentCount] = React.useState(0);

  /**
   * Send what is in the box.
   *
   * The box is left exactly as it is. Emptying it belongs to the conversation,
   * which is the only thing that learns the words got there -- and which goes
   * on doing it after this panel is collapsed, unlike anything held here.
   *
   * Stable across renders, so that a reply arriving token by token does not
   * hand the composer a new callback sixty times a second and take its own
   * memoisation away.
   */
  const submit = React.useCallback((): void => {
    if (draft.trim().length === 0) return;
    setSentCount((n) => n + 1);
    void send(draft);
  }, [draft, send]);

  /**
   * Pick a conversation out of the history sheet and close it.
   *
   * Stable for the same reason as {@link submit}.
   */
  const pickConversation = React.useCallback(
    (id: string): void => {
      setActiveConversationId(id);
      setHistoryOpen(false);
    },
    [setActiveConversationId, setHistoryOpen],
  );

  // Read out here rather than inside the memo below. `t` keeps the same
  // identity for the life of the page -- switching language re-renders
  // without replacing it -- so a memo that depends on `t` and calls it inside
  // would go on showing the sentence in the language it first ran in.
  const networkErrorText = t('chat.error.network');

  /**
   * The one line, and it is only ever saying one thing.
   *
   * Which of the two depends on nothing but whether an answer came back at
   * all. An answer means the network was fine and the server wrote the only
   * sentence anyone wrote about this -- in the reader's own language, which
   * is why it is passed through rather than replaced. No answer means there
   * is nothing to quote and nothing to add: two words, and no advice about
   * what to do next, because that is the reader's own business.
   */
  const notice = React.useMemo(() => {
    if (mishap === null) return null;
    return mishap.kind === 'server' ? mishap.message : networkErrorText;
  }, [mishap, networkErrorText]);

  /** Load a quick-action label into the composer. Stable for the same reason. */
  const quickAction = React.useCallback(
    (label: string): void => {
      if (onQuickAction) onQuickAction(label);
      else setDraft(label);
    },
    [onQuickAction, setDraft],
  );

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
        messages={messages}
        loading={isPending}
        sentCount={sentCount}
        hasEarlier={hasMore}
        onLoadEarlier={loadEarlier}
        onQuickAction={quickAction}
      />
      {/* One line, on the top edge of the composer, for everything this panel
          has to say -- and it says each thing once. Nothing here is a state
          the chat is in, so nothing here stays. */}
      <ChatNotice message={notice} />
      <ChatComposer
        draft={draft}
        turnPhase={turnPhase}
        onChange={setDraft}
        onSubmit={submit}
        onAbort={abort}
      />
      <ConversationHistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        conversations={conversations}
        activeId={activeConversationId ?? undefined}
        onPick={pickConversation}
      />
    </div>
  );
}
