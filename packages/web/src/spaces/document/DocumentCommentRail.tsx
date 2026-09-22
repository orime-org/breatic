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
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { DocumentCommentCard } from '@web/spaces/document/DocumentCommentCard';
import { layOutCards } from '@web/spaces/document/document-comment-layout';
import {
  hoverThread,
  onSelectedThreadsChange,
  selectThreads,
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
import { useCommentAnchors } from '@web/spaces/document/use-comment-anchors';
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

/** The space kept between two cards that would otherwise run together. */
const GAP_BETWEEN_CARDS_PX = 10;

/** What a card is taken to be until it has been on screen once. */
const CARD_HEIGHT_GUESS_PX = 120;

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

  const shown = React.useMemo(
    () => [...cards.unresolved, ...(filter === 'all' ? cards.resolved : [])],
    [cards, filter],
  );
  const ids = React.useMemo(() => shown.map((card) => card.id), [shown]);

  // Where each card's words are, and how far the body has been scrolled. The
  // first changes only when the text does; the second is one number applied
  // to the whole column, which is what keeps the two sides in step.
  const anchors = useCommentAnchors(editor, ids);

  // A card's own height, once it has been on screen. How far the card below
  // has to give way depends on how tall the one above turned out to be.
  const [heights, setHeights] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const measure = React.useCallback(
    (id: string) =>
      (node: HTMLDivElement | null): void => {
        if (node === null) return;
        const height = node.offsetHeight;
        setHeights((held) =>
          held.get(id) === height ? held : new Map(held).set(id, height),
        );
      },
    [],
  );

  // The first of them, because a press on two overlapping highlights marks
  // both and only one can have the column to itself.
  const reading = selected[0] ?? null;
  const placed = React.useMemo(
    () =>
      layOutCards(
        shown
          .filter((card) => anchors.has(card.id))
          .map((card) => ({
            id: card.id,
            anchor: anchors.get(card.id)!,
            height: heights.get(card.id) ?? CARD_HEIGHT_GUESS_PX,
          })),
        reading,
        GAP_BETWEEN_CARDS_PX,
      ),
    [shown, anchors, heights, reading],
  );

  const onHover = React.useCallback(
    (threadId: string | null) => {
      hoverThread(editor, threadId);
    },
    [editor],
  );

  // Reading a card is saying which run of the body is being talked about, so
  // a press here marks that run — the same thing a press on the highlight
  // does from the other side.
  const onRead = React.useCallback(
    (threadId: string) => {
      selectThreads(editor, [threadId]);
    },
    [editor],
  );


  const showOpen = React.useCallback(() => {
    setFilter('open');
  }, []);
  const showAll = React.useCallback(() => {
    setFilter('all');
  }, []);

  const empty = shown.length === 0;

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
      {/* The column does not scroll on its own: it is carried by the body's
          scroll, which is what keeps a card level with its words. */}
      <div
        data-testid='doc-comment-rail-column'
        className='relative flex-1 px-2.5'
      >
        {empty ? (
          <p
            data-testid='doc-comment-rail-empty'
            className='px-4 py-7 text-center text-sm leading-relaxed text-muted-foreground'
          >
            {t('spaces.document.comment.empty')}
          </p>
        ) : (
          <div className='absolute inset-x-2.5 top-0'>
            {shown.map((card) => (
              <div
                key={card.id}
                ref={measure(card.id)}
                // The move is animated: a card giving way to the one being
                // read should read as giving way rather than as the column
                // jumping under the reader (user 2026-09-22).
                className='absolute inset-x-0 transition-[top] duration-200 ease-out motion-reduce:transition-none'
                // The card being read comes to the front. Cards give way to
                // each other by moving, and while one is settling — a reply
                // box opening, a height not measured yet — they can still
                // overlap; the one the reader is on is the one to see whole.
                style={{
                  top: `${placed.get(card.id) ?? 0}px`,
                  zIndex: selected.includes(card.id) ? 1 : undefined,
                }}
                onMouseEnter={() => {
                  onHover(card.id);
                }}
                onMouseLeave={() => {
                  onHover(null);
                }}
                // Both ways a reader arrives at a card: the pointer pressing
                // it, and the focus landing on any control inside it — which
                // is how the keyboard gets here.
                onPointerDown={() => {
                  onRead(card.id);
                }}
                onFocusCapture={() => {
                  onRead(card.id);
                }}
              >
                <DocumentCommentCard
                  card={card}
                  selected={selected.includes(card.id)}
                  {...handling}
                />
              </div>
            ))}
          </div>
        )}
      </div>
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
