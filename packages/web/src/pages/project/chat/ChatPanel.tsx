// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  conversationRuntime,
  useConversationRuntime,
} from '@web/stores/conversation-runtime';
import { chatAttachments, useTray } from '@web/stores/chat-attachments';
import { useConsolidating } from '@web/stores/consolidating';
import { useUIStore } from '@web/stores/ui';
import type { ProjectSpace } from '@web/data/yjs/project-meta';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import type { SpaceContextChipProps } from '@web/pages/project/chat/SpaceContextChip';
import { usePasteCanvas } from '@web/pages/project/chat/use-paste-canvas';
import { ConversationHistorySheet } from '@web/pages/project/chat/ConversationHistorySheet';
import { MessageList } from '@web/pages/project/chat/MessageList';
import { useAttachFiles } from '@web/pages/project/chat/use-attach-files';
import { useChatSession } from '@web/pages/project/chat/use-chat-session';
import { QuestionnaireAnswerContext } from '@web/pages/project/chat/questionnaire-answer';
import { readSpaceContext } from '@web/pages/project/chat/space-context';
import type { ReadSpaces } from '@web/pages/project/chat/space-context';

/**
 * How long a wait goes unmentioned.
 *
 * Under this, nothing is drawn at all: the request usually lands inside it,
 * and a skeleton that appears and disappears inside a third of a second reads
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
   * The Space whose tab is active, if any. Named on the chip beside the plus
   * sign and sent with each message while that chip is on; pasted canvas
   * nodes it holds are handed over from it when it is a canvas.
   */
  activeSpace: ProjectSpace | undefined;
  /** Every Space in the project, listed to the Agent with each message. */
  spaces: readonly ProjectSpace[];
}

/**
 * Project ChatPanel — private per-user agent chat. Does NOT participate
 * in Yjs: the conversation belongs to one user.
 *
 * The messages, and sending and stopping, all come from one hook so that the
 * history and the reply being streamed are never two different lists.
 * @param root0 - The component props.
 * @param root0.projectId - The project this chat belongs to.
 * @param root0.historyOpen - Whether the conversation list is showing.
 * @param root0.onHistoryOpenChange - Called with the next open state for that list.
 * @param root0.onQuickAction - Called with a quick-action label from the empty state.
 * @param root0.activeSpace - The Space whose tab is active, if any.
 * @param root0.spaces - Every Space in the project.
 * @returns The per-user private chat column with message list, composer, and history sheet.
 */
export function ChatPanel({
  projectId,
  historyOpen,
  onHistoryOpenChange,
  onQuickAction,
  activeSpace,
  spaces,
}: ChatPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const spaceContextEnabled = useUIStore((s) => s.spaceContextEnabled);
  const toggleSpace = useUIStore((s) => s.toggleSpaceContext);
  // Built from the Space's name and type, so the memoised composer is handed
  // the same chip when the project meta is re-read with nothing changed.
  const spaceName = activeSpace?.name;
  const spaceType = activeSpace?.type;
  const spaceChip = React.useMemo(
    (): SpaceContextChipProps | undefined =>
      spaceName === undefined || spaceType === undefined
        ? undefined
        : { name: spaceName, type: spaceType, enabled: spaceContextEnabled, onToggle: toggleSpace },
    [spaceName, spaceType, spaceContextEnabled, toggleSpace],
  );
  // Read through a ref at the press: the project meta hands over a fresh
  // array each time anything in it changes, someone going online included,
  // and a callback rebuilt for that would reach the memoised composer as a
  // new onSubmit.
  const spaceSource = React.useRef({ activeSpace, spaces });
  spaceSource.current = { activeSpace, spaces };
  /** The reader's Spaces as they stand; called at the press. */
  const readSpaces = React.useCallback(
    (): ReadSpaces =>
      readSpaceContext({
        projectId,
        ...spaceSource.current,
        enabled: useUIStore.getState().spaceContextEnabled,
        queryClient,
      }),
    [projectId, queryClient],
  );
  const {
    messages,
    status,
    turnPhase,
    navigating,
    hasMore,
    loadEarlier,
    send,
    answer,
    abort,
    conversations,
    hasMoreConversations,
    loadMoreConversations,
    nextPageFailed,
    loadingMore,
    listLoading,
    reloadList,
    currentId,
    draft,
    setDraft,
    switchTo,
    rename,
    remove,
  } = useChatSession(projectId, readSpaces);

  // Two independent gates over one wait, because they answer different
  // questions. Whether there is a conversation to draw at all is `ready`;
  // whether this wait has run long enough to be worth showing is `skeleton`.
  // Collapsing them into one would put the empty-conversation greeting on
  // screen during the wait, which is a whole screenful of the wrong thing.
  const ready = status === 'ready';
  const answering = React.useMemo(() => ({ answer, busy: turnPhase !== 'idle' }), [answer, turnPhase]);
  // A long conversation folds its oldest part into memory before this turn is
  // answered, which is a second model call in front of the reply. Read here
  // rather than passed down the turn: the panel can be unmounted when the
  // word arrives and mounted again while the same turn runs.
  const consolidating = useConsolidating((s) =>
    currentId ? s.byConversation[currentId] === true : false,
  );
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

  // What is attached above the box in the conversation on screen.
  const attachments = useTray(currentId);
  const removeAttachment = React.useCallback(
    (id: string): void => {
      if (currentId) chatAttachments.remove(currentId, id);
    },
    [currentId],
  );
  const attachFiles = useAttachFiles(projectId);

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

  const pasteCanvas = usePasteCanvas(
    projectId,
    activeSpace?.type === 'canvas' ? activeSpace.id : undefined,
  );

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
      // Takes the height that is left, not the height of the column. The
      // column also holds a header, so `h-full` here came to 100% of a
      // container this panel does not have all of -- the two together
      // overflowed it by exactly the header, the page grew a scrollbar of its
      // own, and whichever end it was scrolled to lost that much: the toolbar
      // off the top, or the composer off the bottom.
      className='flex w-full min-h-0 flex-1 flex-col'
    >
      {/* A questionnaire card inside a message answers in the conversation
          this panel holds (inner#1542). */}
      <QuestionnaireAnswerContext.Provider value={answering}>
        <MessageList
          // The conversation travels as a prop rather than as a key. The list
          // does have to notice a switch -- it is what tells it to follow the
          // bottom again -- but keying it made React tear down the scroller and
          // every bubble to do it, and the scroller it discarded stayed in the
          // document: an empty half-column above the conversation, in every
          // project, from the moment the first one opened.
          conversationId={currentId}
          messages={messages}
          consolidating={consolidating}
          ready={ready}
          skeleton={skeleton}
          sentCount={sentCount}
          hasEarlier={hasMore}
          onLoadEarlier={loadEarlier}
          onQuickAction={quickAction}
          navigating={navigating}
        />
      </QuestionnaireAnswerContext.Provider>
      <ChatComposer
        conversationId={currentId ?? null}
        draft={draft}
        turnPhase={turnPhase}
        navigating={navigating}
        onChange={setDraft}
        onSubmit={submit}
        onAbort={abort}
        attachments={attachments}
        attachAccept={attachFiles.accept}
        onAttachFiles={attachFiles.attach}
        onPasteCanvas={pasteCanvas}
        onRemoveAttachment={removeAttachment}
        space={spaceChip}
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
      />
    </div>
  );
}
