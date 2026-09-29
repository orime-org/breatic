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
import type { CommentRail } from '@web/spaces/document/document-comment-rail';
import {
  hiddenAbove,
  inColumnOrder,
  layOutCards,
  liftToReveal,
  nextLift,
} from '@web/spaces/document/document-comment-layout';
import {
  hoverThread,
  hoveredThreadIn,
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
import {
  DRAFT_THREAD_ID,
  draftIn,
  onDraftChange,
  type Draft,
} from '@web/spaces/document/document-comment-draft-range';
import {
  keepRepliesOf,
  onUnsentChange,
  repliesOf,
  writeReply,
} from '@web/spaces/document/document-comment-unsent';
import { DocumentCommentDraftCard } from '@web/spaces/document/DocumentCommentDraftCard';
import {
  useCommentCards,
  type CommentCardView,
} from '@web/spaces/document/use-comment-cards';
import { useCommentWrite } from '@web/spaces/document/use-comment-write';
import { useCurrentUserStore } from '@web/stores/current-user';

interface DocumentCommentRailProps {
  /** The editor whose threads this draws. */
  editor: ToolEditor;
  /** The threads in panel order, read once for the whole Space. */
  rail: CommentRail;
  /** This reader's role, which decides what the cards offer. */
  myRole: ProjectRole;
  /** Closes the panel, which only the reader ever does. */
  onClose: () => void;
  /** The body's scroller, which the panel shares; null before it mounts. */
  scroller: HTMLElement | null;
}

/** Which threads the panel is showing. */
type Filter = 'open' | 'all';

/** The space kept between two cards that would otherwise run together. */
const GAP_BETWEEN_CARDS_PX = 10;

/** What a card is taken to be until it has been on screen once. */
const CARD_HEIGHT_GUESS_PX = 120;

/** How close to the panel's header a card may come (user 2026-09-22). */
const CLEARANCE_BELOW_HEADER_PX = 4;

/** One line of a wheel that counts in lines (Firefox), in pixels. */
const WHEEL_LINE_PX = 16;

/** The CSS variable the column's scroll margin reads the header's reach from. */
const RAIL_CLEAR_VAR = '--rail-clear';

/** What every card takes from the panel, the same for all of them. */
type CardHandling = Omit<
  React.ComponentProps<typeof DocumentCommentCard>,
  'card' | 'marked' | 'reading' | 'draft'
>;

/**
 * The comment panel.
 * @param root0 - Panel props.
 * @param root0.editor - The editor whose threads this draws.
 * @param root0.rail - The threads in panel order.
 * @param root0.myRole - This reader's role.
 * @param root0.onClose - Closes the panel.
 * @param root0.scroller - The body's scroller, moved to show a new draft card.
 * @returns The panel.
 */
export const DocumentCommentRail = React.memo(function DocumentCommentRail({
  editor,
  rail,
  myRole,
  onClose,
  scroller,
}: DocumentCommentRailProps): React.JSX.Element {
  const t = useTranslation();
  const cards = useCommentCards(editor, rail);
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

  // The comment being written, if one is: aimed at words, or dropped and
  // saying why (§9.4.1). The rail answers it with a card of its own; everything
  // else about that card's place is the same rule every other card follows.
  // Read from the editor, which a Space tab switch does not take away.
  const draft = React.useSyncExternalStore(onDraftChange, () =>
    draftIn(editor.prosemirrorState),
  );
  // Pressing the draft card, or putting the focus into it, makes it the card
  // being read. A thread's card takes that turn on a press only; focus on it
  // is the pointer resting there (A7, A24).
  const readDraft = React.useCallback((): void => {
    const reading = selectedThreadsIn(editor.prosemirrorState);
    if (reading.length === 1 && reading[0] === DRAFT_THREAD_ID) return;
    selectThreads(editor, [DRAFT_THREAD_ID]);
  }, [editor]);
  // The draft's turn at being read goes with it: once there is no draft, the
  // effect that keeps `ids` to cards on the panel takes its id out (design
  // §9.4.1, invariant four). A save goes the same way — saving is the comment
  // being finished (user 2026-09-24).
  const draftShowing = draft !== null;

  const said = useCommentWrite();

  const onReply = React.useCallback(
    async (threadId: string, body: string) =>
      (await said(replyToThread(editor, threadId, body))) ?? false,
    [editor, said],
  );
  const onResolve = React.useCallback(
    (threadId: string) => {
      void said(resolveThread(editor, threadId));
    },
    [editor, said],
  );
  const onReopen = React.useCallback(
    (threadId: string) => {
      void said(reopenThread(editor, threadId));
    },
    [editor, said],
  );
  const onDelete = React.useCallback(
    (threadId: string) => {
      void said(removeThread(editor, threadId));
    },
    [editor, said],
  );
  const onDeleteReply = React.useCallback(
    (threadId: string, commentId: string) => {
      void said(removeReply(editor, threadId, commentId));
    },
    [editor, said],
  );

  // What has been written into each thread's reply box and not sent yet. Kept
  // by the editor rather than by the card or this panel: a card is taken off
  // the panel by things the reader did not do — a peer settling the thread, a
  // peer deleting it — and a Space tab switch mounts the panel again, while
  // unsent words are the reader's until they send or clear them.
  const drafts = React.useSyncExternalStore(onUnsentChange, () =>
    repliesOf(editor),
  );
  const onDraft = React.useCallback(
    (threadId: string, body: string) => {
      writeReply(editor, threadId, body);
    },
    [editor],
  );

  // Let go of when the thread itself is gone rather than when the card
  // leaves — a settled thread is still one filter press away with those words
  // in it (design §9.6). Asked of both groups, not of what the panel shows.
  React.useEffect(() => {
    keepRepliesOf(
      editor,
      new Set([...cards.unresolved, ...cards.resolved].map((card) => card.id)),
    );
  }, [editor, cards]);

  // One object, memoised: every card takes the same eight, and a fresh object
  // per render would stop `DocumentCommentCard`'s memo ever bailing out.
  const handling: CardHandling = React.useMemo(
    () => ({
      myRole,
      viewerId,
      onDraft,
      onReply,
      onResolve,
      onReopen,
      onDelete,
      onDeleteReply,
    }),
    [
      myRole,
      viewerId,
      onDraft,
      onReply,
      onResolve,
      onReopen,
      onDelete,
      onDeleteReply,
    ],
  );

  const shown = React.useMemo(
    () => [...cards.unresolved, ...(filter === 'all' ? cards.resolved : [])],
    [cards, filter],
  );
  const ids = React.useMemo(() => shown.map((card) => card.id), [shown]);

  // Where each card's words are, and how far the body has been scrolled. The
  // first changes only when the text does; the second is one number applied
  // to the whole column, which is what keeps the two sides in step.
  // The element the cards are placed inside is what they are measured
  // against, so a card's top needs nothing added to it.
  const column = React.useRef<HTMLDivElement>(null);
  // Keyed on the start alone, which is all the hook measures: the card sits
  // level with where the words begin.
  const draftFrom = draft?.kind === 'aimed' ? draft.from : null;
  const draftAnchor = React.useMemo(
    () => (draftFrom === null ? null : { id: DRAFT_THREAD_ID, from: draftFrom }),
    [draftFrom],
  );
  const anchors = useCommentAnchors(editor, ids, column, draftAnchor);

  // A card's own height, once it has been on screen. How far the card below
  // has to give way depends on how tall the one above turned out to be.
  const [heights, setHeights] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  // Watched rather than read once: a card changes height without the panel
  // rendering — the reply box grows as somebody types, and that re-renders
  // the card alone. Sampled in a ref callback, the card below stays where it
  // was and the growing one paints over it.
  const sizes = React.useRef<ResizeObserver | null>(null);
  if (sizes.current === null && typeof ResizeObserver === 'function') {
    sizes.current = new ResizeObserver((entries) => {
      setHeights((held) => {
        let next: Map<string, number> | null = null;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.thread;
          if (id === undefined) continue;
          const height = (entry.target as HTMLElement).offsetHeight;
          if (held.get(id) === height) continue;
          next ??= new Map(held);
          next.set(id, height);
        }
        return next ?? held;
      });
    });
  }
  React.useEffect(() => () => sizes.current?.disconnect(), []);

  // What a card takes as it arrives and gives back as it goes. Two things
  // each: a place in the observer, and a height in the table above.
  const take = React.useCallback((node: HTMLDivElement, id: string): void => {
    node.dataset.thread = id;
    setHeights((held) =>
      held.get(id) === node.offsetHeight
        ? held
        : new Map(held).set(id, node.offsetHeight),
    );
    sizes.current?.observe(node);
  }, []);
  const giveBack = React.useCallback(
    (node: HTMLDivElement, id: string): void => {
      sizes.current?.unobserve(node);
      setHeights((have) => {
        if (!have.has(id)) return have;
        const next = new Map(have);
        next.delete(id);
        return next;
      });
    },
    [],
  );

  // What the pointer is on, and what is being read, are both said about a
  // card. A thread can leave the panel while they point at it — Resolve and
  // Delete are offered on the card being read, and either takes it off — and
  // the deep paint in the body then marks a card that is no longer on screen
  // (measured 2026-09-23, A8). Asked of what the panel is showing rather than
  // of whether an element was removed: a card's element goes on any render,
  // and only some of those mean the thread went with it.
  React.useEffect(() => {
    const hovered = hoveredThreadIn(editor.prosemirrorState);
    if (
      hovered !== null &&
      !ids.includes(hovered) &&
      !(hovered === DRAFT_THREAD_ID && draftShowing)
    ) {
      hoverThread(editor, null);
    }
    const reading = selectedThreadsIn(editor.prosemirrorState);
    // The draft is a card on the panel too while it shows, though it has no
    // thread to be listed under.
    const still = reading.filter(
      (id) => ids.includes(id) || (id === DRAFT_THREAD_ID && draftShowing),
    );
    if (still.length !== reading.length) selectThreads(editor, still);
  }, [ids, editor, draftShowing]);

  // The first of the selected, because a press on two overlapping highlights
  // marks both and only one can have the column to itself. The draft is one
  // of the cards that can be it (A28, design §9.4.1).
  const reading = selected[0] ?? null;
  const placement = React.useMemo(
    () =>
      layOutCards(
        [
          ...shown.map((card) => ({
            id: card.id,
            // Null for a thread whose run was deleted: nothing to measure, and
            // the layout puts it below the cards that do have words (A13).
            anchor: anchors.get(card.id) ?? null,
            height: heights.get(card.id) ?? CARD_HEIGHT_GUESS_PX,
          })),
          ...(!draftShowing
            ? []
            : [
              {
                id: DRAFT_THREAD_ID,
                anchor: anchors.get(DRAFT_THREAD_ID) ?? null,
                height: heights.get(DRAFT_THREAD_ID) ?? CARD_HEIGHT_GUESS_PX,
              },
            ]),
        ],
        reading,
        GAP_BETWEEN_CARDS_PX,
        CLEARANCE_BELOW_HEADER_PX,
      ),
    [shown, anchors, heights, reading, draftShowing],
  );
  const placed = placement.tops;

  // The panel's own scroll: how far the column is lifted to bring back the
  // cards the one being read pushed up under the header (design §9.6.1).
  // `setLift` is its one writer. A new card being read starts the column
  // over; a layout that leaves less room holds it to what there is, which is
  // what everything reading it takes.
  const [lift, setLift] = React.useState(0);
  React.useEffect(() => {
    setLift(0);
  }, [reading]);
  const lifted = Math.min(lift, placement.raised);

  const aside = React.useRef<HTMLElement>(null);
  const header = React.useRef<HTMLDivElement>(null);

  // The body is moved just enough to show the draft card once it is placed:
  // the card lands level with its words, which can sit under the header or
  // above the screen, and its box took the focus without scrolling. Once per
  // press of an entry, from where the card is going rather than where a move
  // has carried it so far; after that the scroll is the reader's (design
  // §9.4.0). Computed from the two rectangles, as `scrollTabToEdge` does.
  const revealed = React.useRef<number | null>(null);
  const draftEntry = draft?.kind === 'aimed' ? draft.entry : null;
  const draftTop = anchors.has(DRAFT_THREAD_ID)
    ? placed.get(DRAFT_THREAD_ID)
    : undefined;
  const draftHeight = heights.get(DRAFT_THREAD_ID);
  const draftRead = reading === DRAFT_THREAD_ID;
  React.useLayoutEffect(() => {
    const top = column.current;
    const bar = header.current;
    if (
      draftEntry === null ||
      revealed.current === draftEntry ||
      !draftRead ||
      draftTop === undefined ||
      draftHeight === undefined ||
      scroller === null ||
      top === null ||
      bar === null
    ) {
      return;
    }
    revealed.current = draftEntry;
    const cardTop = top.getBoundingClientRect().top + lifted + draftTop;
    const clear = bar.getBoundingClientRect().bottom + CLEARANCE_BELOW_HEADER_PX;
    const floor = scroller.getBoundingClientRect().bottom;
    const by =
      cardTop < clear
        ? cardTop - clear
        : Math.min(Math.max(cardTop + draftHeight - floor, 0), cardTop - clear);
    if (by !== 0) {
      scroller.scrollTo({ top: scroller.scrollTop + by, behavior: 'instant' });
    }
  }, [draftEntry, draftRead, draftTop, draftHeight, lifted, scroller]);
  /**
   * How far a pushed card, or the most hidden of them, reaches above the
   * header — from the layout, the one reading both the wheel and the focus
   * take.
   * @param laid - The layout.
   * @param id - The card, or null for the most hidden.
   * @param now - The lift.
   * @returns The distance, or null before the panel is on screen.
   */
  const hiddenNow = React.useCallback(
    (laid: typeof placement, id: string | null, now: number): number | null => {
      const edge = header.current?.getBoundingClientRect().bottom;
      const columnTop = column.current?.getBoundingClientRect().top;
      if (edge === undefined || columnTop === undefined) return null;
      return hiddenAbove(laid, id, { edge, columnTop, lift: now });
    },
    [],
  );
  // Read by the wheel listener, which is attached once.
  const liftInputs = React.useRef({ lifted, placement });
  React.useEffect(() => {
    liftInputs.current = { lifted, placement };
  }, [lifted, placement]);
  React.useEffect(() => {
    const node = aside.current;
    if (node === null) return;
    /**
     * Takes a wheel turn over the panel when it brings a hidden card back or
     * puts the column back; otherwise leaves it to the body.
     * @param event - The turn.
     */
    const onWheel = (event: WheelEvent): void => {
      // A pinch or Ctrl+wheel is the page zooming, not a scroll.
      if (event.ctrlKey) return;
      const { lifted: now, placement: laid } = liftInputs.current;
      const hidden = hiddenNow(laid, null, now);
      if (hidden === null) return;
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * WHEEL_LINE_PX
          : event.deltaY;
      const next = nextLift({ lift: now, delta, raised: laid.raised, hidden });
      if (!next.taken) return;
      event.preventDefault();
      setLift(next.lift);
    };
    // Not React's `onWheel`: that one is passive, and `preventDefault` there
    // would not keep the turn from scrolling the body.
    node.addEventListener('wheel', onWheel, { passive: false });
    return (): void => {
      node.removeEventListener('wheel', onWheel);
    };
  }, [hiddenNow]);

  // The focus landing on a card the column pushed up under the header lifts
  // the column to show it: Tab reaches cards in column order, so the first
  // stops are exactly those (design §9.6.1). The same cards the wheel brings
  // back, named once by the layout. A card hidden because the body was
  // scrolled is the browser's to bring into view, and the scroll margin
  // below keeps it clear of the header.
  const revealFocused = React.useCallback((id: string): void => {
    const { lifted: now, placement: laid } = liftInputs.current;
    const hidden = hiddenNow(laid, id, now);
    if (hidden === null) return;
    const next = liftToReveal({ lift: now, raised: laid.raised, hidden });
    if (next !== now) setLift(next);
  }, [hiddenNow]);

  // How tall the header is, for the scroll margin everything in the column
  // keeps: the browser bringing a focused card, or a control inside one, into
  // view then leaves it below the header rather than under it.
  const [headerHeight, setHeaderHeight] = React.useState(0);
  React.useLayoutEffect(() => {
    const node = header.current;
    if (node === null) return;
    setHeaderHeight(node.offsetHeight);
  }, []);
  const clearOfHeader = React.useMemo(
    () =>
      ({
        [RAIL_CLEAR_VAR]: `${String(headerHeight + CLEARANCE_BELOW_HEADER_PX)}px`,
      }) as React.CSSProperties,
    [headerHeight],
  );

  // The draft among the rest, in the order they sit: the keyboard walks the
  // column top to bottom.
  const written = React.useMemo(
    () =>
      inColumnOrder<InColumn>(
        [
          ...shown.map((card) => ({ id: card.id, card })),
          ...(draft === null ? [] : [{ id: DRAFT_THREAD_ID, draft }]),
        ],
        placement.order,
      ),
    [shown, draft, placement],
  );

  // How far down the lowest card reaches, which the layout knows as it puts
  // them there. The cards are out of flow, so the panel's own box — its
  // border, its background, and the block the sticky header is held inside
  // — stops at whatever the header and the empty column come to, and a
  // stack taller than that hangs below it (measured 2026-09-23: a comment
  // on the last line of a 40-line document put its card 127.5px past the
  // panel's bottom edge).
  const stackHeight = placement.height;

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

  // Two different nothings, and they send the reader different places: a
  // document nobody has commented on wants to know how to start one, while a
  // filter that happens to be empty wants to say so — what they are looking
  // for is one press away, behind "all".
  // A draft is something to draw, so the line about an empty rail would be
  // arguing with the card on screen (A1's commonest path is the first comment
  // on a document that has none).
  const nothingHere = shown.length === 0 && !draftShowing;
  const nothingAnywhere =
    cards.unresolved.length === 0 && cards.resolved.length === 0;

  return (
    <aside
      ref={aside}
      data-testid='doc-comment-rail'
      className='flex w-72 flex-none flex-col border-l border-border'
    >
      {/* Held at the top while the column scrolls past under it: the panel
          shares the body's scroller, so without this the title and the way
          out of the panel scroll away with the text (user 2026-09-22). The
          background is its own, because what passes beneath it is cards. */}
      <div
        ref={header}
        data-testid='doc-comment-rail-header'
        className='sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background px-3 py-2'
      >
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
        ref={column}
        data-testid='doc-comment-rail-column'
        className='relative flex-1 px-2.5'
        style={{ minHeight: `${String(stackHeight)}px` }}
      >
        {nothingHere ? (
          <p
            data-testid='doc-comment-rail-empty'
            className='px-4 py-7 text-center text-sm leading-relaxed text-muted-foreground'
          >
            {t(
              nothingAnywhere
                ? 'spaces.document.comment.empty'
                : 'spaces.document.comment.nothingUnresolved',
            )}
          </p>
        ) : (
          // Everything focusable in the column keeps clear of the header,
          // the controls inside an open card as much as the card itself.
          <div
            className='absolute inset-x-2.5 top-0 [&_*]:scroll-mt-(--rail-clear)'
            style={{ ...clearOfHeader, transform: `translateY(${String(lifted)}px)` }}
          >
            {written.map((entry) =>
              'draft' in entry ? (
                // Placed by the same numbers as the rest, and measured like
                // them: it grows as the reader writes, and the cards below
                // have to give way (§9.6).
                <PlacedDraft
                  key={entry.id}
                  top={placed.get(entry.id) ?? 0}
                  take={take}
                  giveBack={giveBack}
                  onHover={onHover}
                  onRead={readDraft}
                >
                  <DocumentCommentDraftCard
                    editor={editor}
                    draft={entry.draft}
                    myRole={myRole}
                    reading={reading === entry.id}
                  />
                </PlacedDraft>
              ) : (
                <PlacedCard
                  key={entry.id}
                  card={entry.card}
                  top={placed.get(entry.id) ?? 0}
                  marked={selected.includes(entry.id)}
                  reading={reading === entry.id}
                  draft={drafts.get(entry.id) ?? ''}
                  take={take}
                  giveBack={giveBack}
                  onHover={onHover}
                  onRead={onRead}
                  onFocused={revealFocused}
                  handling={handling}
                />
              ),
            )}
          </div>
        )}
      </div>
    </aside>
  );
});

/** How a card's box moves once it has arrived. */
const MOVES = 'transition-[top] duration-200 ease-out motion-reduce:transition-none';

/**
 * Whether a card's box may animate its `top` yet: from the frame after it
 * first appears. A card arrives before its words are measured, and measuring
 * them makes the browser compute its style at the place it was first put —
 * with the transition on, it then slides from the top of the column to its
 * words. It arrives where it belongs instead, and moves smoothly after that.
 * @returns False until the frame after the box first appears.
 */
function useArrived(): boolean {
  const [arrived, setArrived] = React.useState(false);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setArrived(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);
  return arrived;
}

/** One thing standing in the column: a thread's card or the draft. */
type InColumn =
  | { readonly id: string; readonly card: CommentCardView }
  | { readonly id: string; readonly draft: Draft };

interface PlacedDraftProps {
  /** How far down the column it sits. */
  top: number;
  /** Takes this card's element into the panel's measurements. */
  take: (node: HTMLDivElement, id: string) => void;
  /** Gives back everything the panel held under this card's id. */
  giveBack: (node: HTMLDivElement, id: string) => void;
  /** Says the pointer is resting on this card, or on none. */
  onHover: (threadId: string | null) => void;
  /** Makes the draft the card being read. */
  onRead: () => void;
  /** The draft card. */
  children: React.ReactNode;
}

/**
 * Puts the draft card where the layout said, and lets the panel measure it.
 *
 * The same box a thread's card sits in, and the same press: pressing it, or
 * putting the focus into it, makes it the card being read. Resting on it
 * deepens its words, the way resting on a thread's card does (A24).
 * @param root0 - Where it goes and how the panel measures it.
 * @param root0.top - How far down the column it sits.
 * @param root0.take - Takes its element into the measurements.
 * @param root0.giveBack - Gives back what was held under its id.
 * @param root0.onHover - Says the pointer is resting on it, or on none.
 * @param root0.onRead - Makes the draft the card being read.
 * @param root0.children - The draft card.
 * @returns The positioned box.
 */
function PlacedDraft({
  top,
  take,
  giveBack,
  onHover,
  onRead,
  children,
}: PlacedDraftProps): React.JSX.Element {
  const box = React.useRef<HTMLDivElement>(null);
  const arrived = useArrived();
  React.useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    take(node, DRAFT_THREAD_ID);
    return () => {
      giveBack(node, DRAFT_THREAD_ID);
    };
  }, [take, giveBack]);

  return (
    <div
      ref={box}
      className={cn('absolute inset-x-0 rounded-sm', arrived && MOVES)}
      // The draft is what the reader is working in, so it comes to the front
      // whenever a settling card would otherwise overlap it.
      style={{ top: `${String(top)}px`, zIndex: 1 }}
      onMouseEnter={() => {
        onHover(DRAFT_THREAD_ID);
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
      // The main button only, as a thread's card asks it.
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onRead();
      }}
      onFocusCapture={onRead}
    >
      {children}
    </div>
  );
}

interface PlacedCardProps {
  /** The thread this draws. */
  card: CommentCardView;
  /** How far down the column it sits. */
  top: number;
  /** Whether the press in the body landed on this thread. */
  marked: boolean;
  /** Whether this is the thread being read. */
  reading: boolean;
  /** What has been written into its reply box and not sent. */
  draft: string;
  /** Takes this card's element into the panel's measurements. */
  take: (node: HTMLDivElement, id: string) => void;
  /** Gives back everything the panel held under this card's id. */
  giveBack: (node: HTMLDivElement, id: string) => void;
  /** Says the pointer is resting on this card, or on none. */
  onHover: (threadId: string | null) => void;
  /** Opens this thread. */
  onRead: (threadId: string) => void;
  /** Told when the focus lands on this card. */
  onFocused: (id: string) => void;
  /** What every card takes, memoised once by the panel. */
  handling: CardHandling;
}

/**
 * One card in its place, holding what the panel keeps under its id.
 *
 * A component rather than a `ref` callback on the element: a card leaves for
 * reasons the pointer knows nothing about, so something has to run as it
 * goes, and only a mount effect's cleanup runs then and only then. A callback
 * ref fresh per render is torn down and set up on every render instead, and
 * one kept per id in a map is a cache of our own with its own failure — both
 * were measured, and the second stopped a press on a highlight from opening
 * its thread at all.
 * @param root0 - See {@link PlacedCardProps}.
 * @param root0.card - The thread this draws.
 * @param root0.top - How far down the column it sits.
 * @param root0.marked - Whether the press landed on this thread.
 * @param root0.reading - Whether this is the thread being read.
 * @param root0.draft - What has been written into its reply box.
 * @param root0.take - Takes this card's element into the measurements.
 * @param root0.giveBack - Gives back what was held under this card's id.
 * @param root0.onHover - Says the pointer is resting on it, or on none.
 * @param root0.onRead - Opens this thread.
 * @param root0.onFocused - Told when the focus lands on this card.
 * @param root0.handling - What every card takes.
 * @returns The card in its place.
 */
function PlacedCard({
  card,
  top,
  marked,
  reading,
  draft,
  take,
  giveBack,
  onHover,
  onRead,
  onFocused,
  handling,
}: PlacedCardProps): React.JSX.Element {
  const box = React.useRef<HTMLDivElement>(null);
  const arrived = useArrived();
  // Layout rather than passive: the height read here is what places every
  // card below this one, and a frame with it missing draws them overlapping.
  React.useLayoutEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    take(node, card.id);
    return () => {
      giveBack(node, card.id);
    };
  }, [card.id, take, giveBack]);

  return (
    // A card is what the reader acts on, and it cannot be a button: an open
    // one carries its own buttons and its reply box. What this rule asks for
    // beyond focus and a press key is a role, which is screen reader
    // semantics — not supported by this product (docs/ACCESSIBILITY.md), and
    // the only part here no other reader gains from.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={box}
      // The move is animated: a card giving way to the one being read should
      // read as giving way rather than as the column jumping under the
      // reader (user 2026-09-22).
      className={cn(
        'absolute inset-x-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-active-border',
        arrived && MOVES,
      )}
      // The card being read comes to the front. Cards give way to each other
      // by moving, and while one is settling — a reply box opening, a height
      // not measured yet — they can still overlap; the one the reader is on
      // is the one to see whole.
      style={{
        top: `${String(top)}px`,
        zIndex: reading ? 1 : undefined,
      }}
      onMouseEnter={() => {
        onHover(card.id);
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
      // The controls a card holds are drawn only once it is open, so the
      // card takes the focus itself or the keyboard reaches none of them.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      // The main button only, as the body's own press handler asks it
      // (`document-comment-selection.ts`): reading a card makes it the
      // column's pivot and moves it, and a right-click wanting the quote
      // would have its menu open over words that then slide away.
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        onRead(card.id);
      }}
      // Reaching a card is what resting a pointer on it is, not what
      // pressing it is: the words go deeper (A24) and the thread stays shut
      // until the reader says to open it (A7). Opening on arrival would also
      // move the card — reading one makes it the column's pivot — out from
      // under the focus ring the browser had just scrolled to. A card the
      // column pushed up under the header is lifted into view (§9.6.1).
      onFocusCapture={() => {
        onHover(card.id);
        onFocused(card.id);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        onHover(null);
      }}
      // The press, from the keyboard. Keys that reach here from a control
      // inside an open card are that control's to answer.
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onRead(card.id);
      }}
    >
      <DocumentCommentCard
        card={card}
        marked={marked}
        reading={reading}
        draft={draft}
        {...handling}
      />
    </div>
  );
}

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
