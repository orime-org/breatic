// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel down the right-hand side of a document (#18, A4 · A9 · A18).
 *
 * A column beside the body rather than a layer over it: opening it narrows
 * the body and closing it widens it again, which is what a three-column Space
 * does (design §5, user 2026-09-22). The outline on the left is the same
 * shape and arrives with task #97.
 *
 * NOTHING HERE DECIDES WHEN IT IS ON SCREEN. The reader does, through the
 * whole-document menu or this panel's own close button, and `DocumentEditor`
 * holds that one bit. A comment arriving from a peer marks the `⋯` button and
 * changes nothing else (§5) — the alternative moves the body sideways under a
 * caret somebody is using.
 *
 * The filter is the two the demo draws. Resolved threads are behind "all"
 * rather than gone, because reopening one is how a settled discussion comes
 * back (A9).
 */

import { X } from 'lucide-react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { DocumentCommentCard } from '@web/spaces/document/DocumentCommentCard';
import {
  onSelectedThreadsChange,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  removeReply,
  removeThread,
  reopenThread,
  replyToThread,
  resolveThread,
} from '@web/spaces/document/document-comment-thread-actions';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import { useCommentCards } from '@web/spaces/document/use-comment-cards';
import { useCurrentUserStore } from '@web/stores/current-user';

interface DocumentCommentRailProps {
  /** The editor whose threads this draws. */
  editor: ToolEditor;
  /** This reader's role, which decides what the cards offer. */
  myRole: ProjectRole;
  /** Closes the panel, which only the reader ever does. */
  onClose: () => void;
}

/** Which threads the panel is showing. */
type Filter = 'open' | 'all';

/**
 * The comment panel.
 * @param root0 - Panel props.
 * @param root0.editor - The editor whose threads this draws.
 * @param root0.myRole - This reader's role.
 * @param root0.onClose - Closes the panel.
 * @returns The panel.
 */
export const DocumentCommentRail = React.memo(function DocumentCommentRail({
  editor,
  myRole,
  onClose,
}: DocumentCommentRailProps): React.JSX.Element {
  const t = useTranslation();
  const cards = useCommentCards(editor);
  const [filter, setFilter] = React.useState<Filter>('open');
  // Who is reading, for the rights each card draws itself with. The store is
  // where every other surface asks the same question.
  const viewerId = useCurrentUserStore((state) => state.user?.id);
  // Which threads the reader pressed in the body. The panel marks them and
  // brings the first into view, which is A6's half of "the comment opens".
  const selected = React.useSyncExternalStore(
    onSelectedThreadsChange,
    () => selectedThreadsIn(editor.prosemirrorState),
  );

  const onReply = React.useCallback(
    (threadId: string, body: string) => replyToThread(editor, threadId, body),
    [editor],
  );
  const onResolve = React.useCallback(
    (threadId: string) => {
      void resolveThread(editor, threadId);
    },
    [editor],
  );
  const onReopen = React.useCallback(
    (threadId: string) => {
      void reopenThread(editor, threadId);
    },
    [editor],
  );
  const onDelete = React.useCallback(
    (threadId: string) => {
      void removeThread(editor, threadId);
    },
    [editor],
  );
  const onDeleteReply = React.useCallback(
    (threadId: string, commentId: string) => {
      void removeReply(editor, threadId, commentId);
    },
    [editor],
  );

  // One object, memoised: every card takes the same seven, and a fresh object
  // per render would stop `DocumentCommentCard`'s memo ever bailing out.
  const handling = React.useMemo(
    () => ({
      myRole,
      viewerId,
      onReply,
      onResolve,
      onReopen,
      onDelete,
      onDeleteReply,
    }),
    [myRole, viewerId, onReply, onResolve, onReopen, onDelete, onDeleteReply],
  );

  // The first of them, because a press on two overlapping highlights marks
  // both and only one place can be scrolled to.
  const bring = selected[0];
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (bring === undefined) return;
    list.current
      ?.querySelector(`[data-thread="${bring}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [bring]);

  const showOpen = React.useCallback(() => {
    setFilter('open');
  }, []);
  const showAll = React.useCallback(() => {
    setFilter('all');
  }, []);

  const resolved = filter === 'all' ? cards.resolved : [];
  const empty = cards.unresolved.length === 0 && resolved.length === 0;

  return (
    <aside
      data-testid='doc-comment-rail'
      className='flex w-72 flex-none flex-col border-l border-border'
    >
      <div className='flex items-center gap-2 border-b border-border px-3 py-2'>
        <span className='text-sm font-medium'>
          {t('spaces.document.comment.railTitle')}
        </span>
        <div className='ml-auto flex gap-0.5'>
          <FilterButton
            id='open'
            on={filter === 'open'}
            label={t('spaces.document.comment.filterOpen')}
            onPress={showOpen}
          />
          <FilterButton
            id='all'
            on={filter === 'all'}
            label={t('spaces.document.comment.filterAll')}
            onPress={showAll}
          />
        </div>
        <Button
          variant='ghost'
          size='icon'
          className='size-5.5'
          aria-label={t('spaces.document.comment.closeRail')}
          data-testid='doc-comment-rail-close'
          onClick={onClose}
        >
          <X className='h-3.5 w-3.5' />
        </Button>
      </div>
      <ScrollArea className='flex-1' viewportClassName='p-2.5'>
        {empty ? (
          <p
            data-testid='doc-comment-rail-empty'
            className='px-4 py-7 text-center text-sm leading-relaxed text-muted-foreground'
          >
            {t('spaces.document.comment.empty')}
          </p>
        ) : (
          <div ref={list} className='flex flex-col gap-2.5'>
            {cards.unresolved.map((card) => (
              <DocumentCommentCard
                key={card.id}
                card={card}
                selected={selected.includes(card.id)}
                {...handling}
              />
            ))}
            {resolved.length > 0 && (
              <div
                data-testid='doc-comment-rail-resolved'
                className='mt-0.5 flex flex-col gap-2.5 border-t border-border pt-2.5'
              >
                <p className='px-0.5 text-2xs text-muted-foreground'>
                  {t('spaces.document.comment.resolvedGroup', {
                    count: resolved.length,
                  })}
                </p>
                {resolved.map((card) => (
                  <DocumentCommentCard
                    key={card.id}
                    card={card}
                    selected={selected.includes(card.id)}
                    {...handling}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
});

/**
 * One of the two filter buttons.
 * @param root0 - Button props.
 * @param root0.id - Which filter, for the test id.
 * @param root0.on - Whether this one is in force.
 * @param root0.label - What it says.
 * @param root0.onPress - Switches to it.
 * @returns The button.
 */
function FilterButton({
  id,
  on,
  label,
  onPress,
}: {
  id: Filter;
  on: boolean;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Button
      variant={null}
      size={null}
      aria-pressed={on}
      data-testid={`doc-comment-rail-filter-${id}`}
      onClick={onPress}
      className={cn(
        'rounded-chrome px-2 py-0.5 text-2xs',
        on ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
    </Button>
  );
}
