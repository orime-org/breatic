// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { useTranslation } from '@web/i18n/use-translation';
import { useExclusiveOverlay } from '@web/lib/use-exclusive-overlay';
import { conversationRuntime, useConversationRuntime } from '@web/stores/conversation-runtime';

import { ChatPanel } from '@web/pages/project/chat/ChatPanel';
import { AgentColHeader } from '@web/pages/project/chrome/agent-header/AgentColHeader';

interface AgentColumnProps {
  /** Project whose chat this column shows. */
  projectId: string;
}

/**
 * The agent column: its header, its chat, and the scrim over both.
 *
 * All three read the same thing -- which conversations this project has, and
 * which one is on screen -- so they are assembled here rather than in the page.
 * The header is a sibling of the panel and not a child of it, which is why the
 * list being open is held at this level: the button that opens it is up there
 * and the sheet it opens is down here.
 * @param root0 - The component props.
 * @param root0.projectId - Project whose chat this column shows.
 * @returns The column.
 */
export function AgentColumn({ projectId }: AgentColumnProps): React.JSX.Element {
  const t = useTranslation();
  const [historyOpen, setHistoryOpen] = useExclusiveOverlay('conversation-history');

  const status = useConversationRuntime((s) => s.openStatus[projectId] ?? 'idle');
  const currentId = useConversationRuntime((s) => s.currentByProject[projectId]);
  // From the conversation, not from its row in the list. The list holds one
  // page, ordered by when each conversation was last used and fetched afresh
  // every time it is opened -- a conversation nobody has spoken in for a while
  // is simply not on it, and a name read from there would disappear with the
  // page while the conversation it belongs to is still on screen.
  const currentTitle = useConversationRuntime((s) =>
    currentId === undefined ? null : (s.conversations[currentId]?.title ?? null),
  );
  const unreachable = status === 'failed';
  const arrived = currentId !== undefined;
  // What the server said, when it said anything. The scrim covers the line
  // that would otherwise carry it, so it has to say it itself -- otherwise a
  // reader who was removed from the project reads "network error" while their
  // network is fine, and the sentence that would have told them is underneath.
  const why = useConversationRuntime((s) => s.openFailure[projectId]);

  // A sheet is portalled to the body and `inert` only reaches down the tree it
  // is on, so the scrim below cannot cover one that is already open: it would
  // float above the scrim, fully usable, over a column that says it cannot be
  // operated. Closing it is what makes that true -- and there is nothing in it
  // worth keeping open anyway, since every row in it acts on a list that could
  // not be read.
  React.useEffect(() => {
    if (unreachable) setHistoryOpen(false);
  }, [unreachable, setHistoryOpen]);

  /** Ask for this project's chat again, after it could not be read. */
  const reload = React.useCallback((): void => {
    void conversationRuntime.ensureLoaded(projectId);
  }, [projectId]);

  // A toggle, not an opener: the button says "conversation history" and the
  // reader reaches for it again to put the list away.
  const toggleHistory = React.useCallback(
    (): void => setHistoryOpen(!historyOpen),
    [historyOpen, setHistoryOpen],
  );

  const startNew = React.useCallback((): void => {
    void conversationRuntime.startNew(projectId);
  }, [projectId]);

  const renameCurrent = React.useCallback(
    (next: string): void => {
      if (currentId) void conversationRuntime.rename(projectId, currentId, next);
    },
    [projectId, currentId],
  );

  return (
    <aside
      data-testid='agent-column'
      // `relative` so the scrim below covers this column and nothing else.
      // Without it the nearest positioned ancestor is the one wrapping the
      // TopBar and the whole canvas, and an `absolute inset-0` scrim would
      // black out the entire workspace.
      //
      // `bg-background` rather than `bg-card`: the chat surface is the same
      // one a document space uses, in both themes.
      className='relative flex w-[320px] shrink-0 flex-col border-r border-border bg-background'
    >
      {/* Everything under the scrim leaves the tab order with it. A scrim
          that only covers pixels still lets Tab walk into the buttons behind
          it, and the sheet one of them opens is portalled to the body at a
          higher layer -- so it would draw on top of the thing meant to be
          blocking it. `inert` is what makes "cannot be operated" true rather
          than merely looking true. */}
      {/* A boolean, not an empty string. React 19 treats `inert=""` as false
          and removes the attribute outright, which leaves a scrim that stops
          the mouse and nothing else: Tab still walks into the header beneath
          it, and the sheet one of those buttons opens is portalled to the body
          above the scrim, fully usable. */}
      <div className='contents' inert={unreachable}>
        <AgentColHeader
          conversationName={currentTitle ?? ''}
          // The stand-in says "this one has no name", and that is something
          // only a conversation in hand can be said about. Until one arrives
          // the header says nothing -- the same silence the message column
          // keeps, for the same reason: a conversation still on its way may
          // well have a name, and guessing it has none is a guess the reader
          // reads as fact.
          conversationNamePlaceholder={arrived ? t('chat.conversation.untitled') : ''}
          onOpenHistory={toggleHistory}
          onNewConversation={startNew}
          onRenameConversation={renameCurrent}
        />
        <ChatPanel
          projectId={projectId}
          historyOpen={historyOpen}
          onHistoryOpenChange={setHistoryOpen}
        />
      </div>
      {unreachable ? <ChatUnreachable onReload={reload} reason={why} /> : null}
    </aside>
  );
}

interface ChatUnreachableProps {
  onReload: () => void;
  /** What the server said, if it said anything. */
  reason?: string;
}

/**
 * The column when its conversations could not be read.
 *
 * Covers the header as well as the chat, on purpose: with no list, the entries
 * up there -- pick a conversation, start one, rename this one -- have nothing
 * to act on, and leaving them would be putting up buttons whose only outcome
 * is to fail again. One layer over the lot, and one thing to do.
 *
 * Hand-written rather than a primitive: every overlay in `components/ui` is
 * `fixed inset-0`, a viewport-level scrim, and what is wanted here covers one
 * column. The look is this column's own -- a wash off `--background` rather
 * than the dim used behind a dialog -- because the two say different things.
 * A dialog's scrim says something is in front; this says this column is
 * broken.
 * @param root0 - The component props.
 * @param root0.onReload - Called when the reader asks to try again.
 * @param root0.reason - What the server said, if it said anything.
 * @returns The scrim.
 */
function ChatUnreachable({ onReload, reason }: ChatUnreachableProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div
      data-testid='chat-unreachable'
      role='alert'
      className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center'
      style={{
        background: 'color-mix(in srgb, var(--color-background) 86%, transparent)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <span className='text-sm font-semibold text-status-error-foreground'>
        {reason === undefined ? t('chat.load.failedTitle') : t('chat.load.refusedTitle')}
      </span>
      <span className='text-xs text-muted-foreground'>{reason ?? t('chat.load.failedBody')}</span>
      <Button variant='outline' size='sm' onClick={onReload} data-testid='chat-reload'>
        {t('chat.load.retry')}
      </Button>
    </div>
  );
}
