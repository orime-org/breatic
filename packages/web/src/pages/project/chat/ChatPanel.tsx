// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { useChatStore } from '@web/stores';
import { useTranslation } from '@web/i18n/use-translation';

import { StreamRefusedError } from '@web/data/stream/sse';
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
    failedToOpen,
    canSend,
    streaming,
    hasMore,
    connectionLost,
    earlierFailed,
    loadEarlier,
    retryOpen,
    send,
    abort,
  } = useChatSession(projectId);
  const t = useTranslation();
  const draft = useChatStore((s) => s.composerDraft);
  const setDraft = useChatStore((s) => s.setComposerDraft);
  const clearDraft = useChatStore((s) => s.clearComposerDraft);
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
   * What the panel has to say about the last thing that went wrong.
   *
   * One line, on the composer, for every failure the panel can report. It is
   * cleared by trying again — that is the only thing that makes the last
   * failure old news, and it means the reader never has to dismiss anything.
   */
  const [notice, setNotice] = React.useState<string | null>(null);

  /**
   * Send the trimmed composer draft and clear the input.
   *
   * Stable across renders, so that a reply arriving token by token does not
   * hand the composer a new callback sixty times a second and take its own
   * memoisation away.
   */
  const submit = React.useCallback((): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    setSentCount((n) => n + 1);
    setNotice(null);
    // Cleared here rather than when the reply ends. The composer is only live
    // when there is a conversation to write to, so by the time this runs the
    // message is already in the list — waiting for the whole turn would leave
    // the user's words sitting in the box beside their own sent bubble, and
    // wipe anything typed while the reply streamed in.
    void send(trimmed).catch((err: unknown) => {
      // Two failures, one line each, both on the composer. When the server
      // answered it said why, in the reader's language — sse.ts goes to the
      // trouble of reading that out of the error envelope, and dropping it
      // here would waste the only sentence anyone wrote about this refusal.
      // When it never answered there is nothing to quote, and the reader
      // needs to know it was the connection and not their message.
      setNotice(
        err instanceof StreamRefusedError ? err.message : t('chat.error.notSent'),
      );
      // It was not sent, and the server kept no record of it — so nothing of
      // the attempt is on screen to explain itself. Handing the words back is
      // the explanation: the message is where the user left it, ready to send
      // again, rather than gone with nothing to show for it.
      //
      // Only into a box that is still empty. The composer stays live for the
      // whole turn and carrying on typing is the ordinary thing to do, so
      // writing over whatever is in there would take away words that were
      // never in trouble — with no message, no undo, and nowhere to look for
      // them. Read from the store rather than the render that started the
      // send, which closed over the draft as it was then.
      if (useChatStore.getState().composerDraft === '') setDraft(trimmed);
    });
    clearDraft();
  }, [draft, send, setDraft, clearDraft, t]);

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
  const openFailedText = t('chat.error.openFailed');
  const retryText = t('chat.error.retry');
  const earlierFailedText = t('chat.error.loadEarlierFailed');
  const connectionLostText = t('chat.error.connectionLost');

  /**
   * What the one notice line is saying, and what to press about it.
   *
   * Four things can be wrong and only one line to say them in, so they are
   * ranked. Opening failed comes first because it rules the others out --
   * with no conversation nothing can be sent and nothing can be reached back
   * for. Then the two the reader is waiting on an answer to, the send ahead
   * of the earlier page because their own words are what is at stake. The
   * dropped connection comes last: it is the state the panel is in rather
   * than the answer to something just pressed.
   */
  const noticeState = React.useMemo((): {
    message: string | null;
    action?: { label: string; onClick: () => void };
  } => {
    if (failedToOpen) {
      return { message: openFailedText, action: { label: retryText, onClick: retryOpen } };
    }
    if (notice !== null) return { message: notice };
    if (earlierFailed) return { message: earlierFailedText };
    if (connectionLost) return { message: connectionLostText };
    return { message: null };
  }, [
    failedToOpen,
    notice,
    earlierFailed,
    connectionLost,
    openFailedText,
    retryText,
    earlierFailedText,
    connectionLostText,
    retryOpen,
  ]);

  /**
   * Reach further back, and let the line talk about that instead.
   *
   * There is one line for everything the panel has to say, and what it was
   * saying belonged to something the reader has now moved on from. Left
   * standing, it would still be there when this press fails too -- so the
   * reader would press a button and watch absolutely nothing change. The
   * conversation clears its own half of this the same way, when a turn
   * starts.
   */
  const loadEarlierMessages = React.useCallback((): void => {
    setNotice(null);
    loadEarlier();
  }, [loadEarlier]);

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
        loading={isPending || failedToOpen}
        sentCount={sentCount}
        hasEarlier={hasMore}
        onLoadEarlier={loadEarlierMessages}
        onQuickAction={quickAction}
      />
      {/* A chat that would not open is the same kind of news as a message
          that would not send, and it belongs in the same place — a second
          bar at the top of the panel would be one more spot to learn to
          look at, and the two could disagree. Which of them this line is
          saying, and why in that order, is worked out above. */}
      <ChatNotice message={noticeState.message} action={noticeState.action} />
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
        onPick={pickConversation}
      />
    </div>
  );
}
