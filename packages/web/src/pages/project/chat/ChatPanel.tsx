// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  conversationRuntime,
  useConversationRuntime,
} from '@web/stores/conversation-runtime';
import type { ChatMishap } from '@web/stores/conversation-runtime';
import { useTranslation } from '@web/i18n/use-translation';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { ChatNotice } from '@web/pages/project/chat/ChatNotice';
import { ConversationHistorySheet } from '@web/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@web/pages/project/chat/MessageList';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';

/**
 * How long a wait goes unmentioned.
 *
 * Under this, nothing is drawn at all: the request usually lands inside it,
 * and a skeleton that appears and disappears inside a fifth of a second reads
 * as a flicker rather than as progress. Past it, the wait is real enough to
 * show.
 */
const SKELETON_AFTER_MS = 300;

interface ChatPanelProps {
  /** Project this chat belongs to — the chat is opened against it. */
  projectId: string;
  /**
   * Whether the conversation list is showing.
   *
   * Held by the column rather than here, because the button that opens it is
   * in the header -- a sibling of this panel, not a child.
   */
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
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
 * @param root0.historyOpen - Whether the conversation list is showing.
 * @param root0.onHistoryOpenChange - Called with the next open state for that list.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @param root0.disabled - When true, renders the panel disabled (viewers cannot interact).
 * @returns The per-user private chat column with message list, composer, and history sheet.
 */
export function ChatPanel({
  projectId,
  historyOpen,
  onHistoryOpenChange,
  onQuickAction,
  disabled = false,
}: ChatPanelProps): React.JSX.Element {
  const {
    messages,
    status,
    turnPhase,
    navigating,
    hasMore,
    mishap,
    loadEarlier,
    send,
    abort,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    nextPageFailed,
    loadingMore,
    listLoading,
    rowMishap,
    reloadList,
    currentId,
    draft,
    setDraft,
    switchTo,
    rename,
    remove,
  } = useChatSession(projectId, historyOpen);
  const t = useTranslation();

  // Two independent gates over one wait, because they answer different
  // questions. Whether there is a conversation to draw at all is `ready`;
  // whether this wait has run long enough to be worth showing is `skeleton`.
  // Collapsing them into one would put the empty-conversation greeting on
  // screen during the wait, which is a whole screenful of the wrong thing.
  const ready = status === 'ready';
  const [skeleton, setSkeleton] = React.useState(false);
  React.useEffect(() => {
    if (ready || status === 'failed') {
      setSkeleton(false);
      return undefined;
    }
    const showing = setTimeout(() => setSkeleton(true), SKELETON_AFTER_MS);
    return () => clearTimeout(showing);
  }, [ready, status]);
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
    // Read at the press rather than closed over, which is what lets this
    // callback be the same one across renders. Handed to a memoised composer
    // that is re-rendered for every keystroke otherwise -- and the claim that
    // its props are stable was, until this, not true of this one.
    const conversationId = useConversationRuntime.getState().currentByProject[projectId];
    const typed = conversationRuntime.draftOf(conversationId);
    if (typed.trim().length === 0) return;
    setSentCount((n) => n + 1);
    void send(typed);
  }, [projectId, send]);

  /**
   * Pick a conversation out of the history sheet and close it.
   *
   * Stable for the same reason as {@link submit}.
   */
  const pickConversation = React.useCallback(
    (id: string): void => {
      switchTo(id);
      onHistoryOpenChange(false);
    },
    [switchTo, onHistoryOpenChange],
  );

  // Read out here rather than inside the memo below. `t` keeps the same
  // identity for the life of the page -- switching language re-renders
  // without replacing it -- so a memo that depends on `t` and calls it inside
  // would go on showing the sentence in the language it first ran in.
  const networkErrorText = t('chat.error.network');
  const turnFailedText = t('chat.error.turnFailed');
  const goneText = t('chat.conversation.gone');

  /**
   * Put a mishap into words, wherever it is going to be drawn.
   *
   * One function for both places, because which of the four sentences a
   * mishap gets is a property of the mishap, not of where it is shown.
   */
  const sayMishap = React.useCallback(
    (m: ChatMishap): string => {
      // Not an error -- the conversation was there and is not any more.
      if (m.kind === 'gone') return goneText;
      // The server wrote this one for the reader, in their own language.
      if (m.kind === 'server') return m.message;
      // It answered, but with nothing a reader could act on -- so this end
      // says the one thing that is true: the reply is not coming, send again.
      if (m.kind === 'turn') return turnFailedText;
      return networkErrorText;
    },
    [goneText, networkErrorText, turnFailedText],
  );

  /**
   * The one line, and it is only ever saying one thing.
   *
   * Four things it can be, and which one turns on what came back with the
   * answer. A sentence of ours did, and it is passed through rather than
   * replaced -- the server wrote it in the reader's own language, and it is
   * the only sentence anyone wrote about this. A 404 is the exception among
   * those: the server's words are about a resource, while this end knows
   * which one and that nothing went wrong, so it says that instead. An answer
   * with none of ours in it says only that the turn is over, so this end
   * supplies the one thing that is true about that. No answer at all leaves
   * nothing to quote and nothing to add: two words, and no advice about what
   * to do next, because that is the reader's own business.
   */
  const notice = React.useMemo(
    () => (mishap === null ? null : sayMishap(mishap)),
    [mishap, sayMishap],
  );

  /**
   * What the list says about the row an action was taken on, in words.
   *
   * The same three kinds as the panel's own line, read the same way -- the
   * difference is only where it is drawn.
   */
  const rowNotice = React.useMemo(() => {
    if (rowMishap === null) return null;
    // The id travels as it is: a row's id puts the words against that row,
    // and null means they are about the list itself.
    return { conversationId: rowMishap.conversationId, text: sayMishap(rowMishap) };
  }, [rowMishap, sayMishap]);

  /**
   * Fetch the list afresh every time it is opened.
   *
   * Where the reader had paged to, and what they saw, belong to the last time
   * they opened it -- and another tab of theirs may have started, renamed or
   * deleted conversations since.
   */
  React.useEffect(() => {
    if (historyOpen) reloadList();
  }, [historyOpen, reloadList]);

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
        // The conversation travels as a prop rather than as a key. The list
        // does have to notice a switch -- it is what tells it to follow the
        // bottom again -- but keying it made React tear down the scroller and
        // every bubble to do it, and the scroller it discarded stayed in the
        // document: an empty half-column above the conversation, in every
        // project, from the moment the first one opened.
        conversationId={currentId}
        messages={messages}
        ready={ready}
        skeleton={skeleton}
        sentCount={sentCount}
        hasEarlier={hasMore}
        onLoadEarlier={loadEarlier}
        onQuickAction={quickAction}
        navigating={navigating}
      />
      {/* One line, on the top edge of the composer, for everything this panel
          has to say -- and it says each thing once. Nothing here is a state
          the chat is in, so nothing here stays. */}
      {/* Keyed by which telling this is, so the same sentence twice is torn
          down and put up again -- otherwise React leaves the line alone and
          the second failure is invisible and unspoken. */}
      <ChatNotice key={mishap?.at ?? 'none'} message={notice} />
      <ChatComposer
        draft={draft}
        turnPhase={turnPhase}
        navigating={navigating}
        onChange={setDraft}
        onSubmit={submit}
        onAbort={abort}
      />
      <ConversationHistorySheet
        open={historyOpen}
        onOpenChange={onHistoryOpenChange}
        conversations={conversations}
        activeId={currentId}
        onPick={pickConversation}
        onRename={rename}
        onDelete={remove}
        hasMore={hasMoreConversations}
        onReachEnd={loadMoreConversations}
        loadingMore={loadingMore}
        nextPageFailed={nextPageFailed}
        listLoading={listLoading}
        rowMishap={rowNotice}
      />
    </div>
  );
}
