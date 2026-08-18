// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { MoreVertical } from 'lucide-react';
import * as React from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { ScrollArea } from '@web/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import { cn } from '@web/lib/utils';
import { CONVERSATION_TITLE_MAX_CHARS } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';
import { useScrolledToEnd } from '@web/lib/use-scrolled-to-end';
import { NOTICE_LINGERS_MS } from '@web/pages/project/chat/notice-timing';

/**
 * How the button that opens this list is found from a press landing on it.
 *
 * The button is in the column header, not in the sheet, so the sheet can only
 * recognise it by something it puts in the document. One name for it, in one
 * place, because the header writes it and this file reads it -- two copies of
 * a string nothing checks is how the guard below quietly stops guarding.
 */
export const OPEN_CONVERSATION_HISTORY_TESTID = 'open-conversation-history';

/**
 * Whether a press that Radix called "outside" landed on the button that opens
 * this list.
 *
 * That button sits in the column header, above where the sheet reaches, so
 * Radix counts pressing it as pressing outside: the sheet closes, and then the
 * button's own click opens it again. On screen that is a press that did
 * nothing, and it fetches the whole list a second time. Measured in the
 * browser -- jsdom never gets as far as calling this, so what the sheet does
 * with the answer is only ever seen there.
 * @param target - What the press landed on, as the event reports it.
 * @returns Whether the press belongs to that button.
 */
export function pressedTheButtonThatOpensThisList(target: EventTarget | null): boolean {
  // Up the tree, not the element itself: the press lands on whatever is drawn
  // inside the button, which is an icon.
  return target instanceof Element
    ? target.closest(`[data-testid="${OPEN_CONVERSATION_HISTORY_TESTID}"]`) !== null
    : false;
}

/**
 * One conversation as a row shows it.
 *
 * Only what is on screen. The server sends the whole record; a row needs the
 * name, when it was last used, and the id to act on -- and declaring the rest
 * would have this component promise things it does not read.
 */
export interface ConversationRow {
  id: string;
  /** Null while the conversation has no name of its own. */
  title: string | null;
  /** ISO timestamp of the last activity, for the relative label. */
  updatedAt: string;
}

interface ConversationHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ReadonlyArray<ConversationRow>;
  activeId?: string;
  onPick: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** The project has conversations older than the ones listed. */
  hasMore: boolean;
  /** Called when the reader reaches the end of what has been fetched. */
  onReachEnd: () => void;
  /** A request for the next page is out. */
  loadingMore: boolean;
  /**
   * The last attempt at the next page failed.
   *
   * Two things follow. The reader is told here rather than in the panel: this
   * sheet is opaque and covers the column, so a line above the composer is a
   * line nobody can read. And the watcher that notices the end of the list is
   * rebuilt, which is what lets reaching the end count again -- a failure
   * moves nothing, so the end never crosses back into view on its own.
   */
  nextPageFailed: boolean;
  /**
   * The first page is on its way.
   *
   * "Nothing here" and "not known yet" are different sentences, and the list
   * holds nothing in both cases. Saying the wrong one has the reader close
   * this and believe they misremembered.
   */
  listLoading?: boolean;
  /**
   * What to say inside the list, and which row it is about.
   *
   * This sheet covers the whole column, so the panel's own line -- on the top
   * edge of the composer -- is a line nobody can read while it is open. The
   * words go against the row named by `conversationId` when this page holds
   * it, and at the top of the list otherwise: `null` says they are about the
   * list itself, and a row this page does not hold has nowhere else to put
   * them. `at` is when it was said, which is what tells two failures apart
   * when they say the same thing.
   */
  rowMishap?: { conversationId: string | null; text: string; at: number } | null;
}

/**
 * Bucket of the relative timestamp + the params needed for an ICU
 * MessageFormat plural string. Pure — no React, no `t()` call — so
 * the buckets can be tested without an i18n runtime.
 */
export interface RelativeTime {
  key:
    | 'chat.relative.justNow'
    | 'chat.relative.minutesAgo'
    | 'chat.relative.hoursAgo'
    | 'chat.relative.yesterday'
    | 'chat.relative.daysAgo'
    | 'chat.relative.weeksAgo'
    | 'chat.relative.monthsAgo'
    | 'chat.relative.isoDate';
  params?: Record<string, string | number>;
}

/**
 * Bucket an ISO timestamp into a relative-time key + params, so callers
 * can `t(rel.key, rel.params)` to render the localized label. Falls back
 * to ISO date when the timestamp is older than a year (or unparseable).
 * @param iso - The ISO timestamp of the latest message.
 * @param now - The reference "now" epoch in ms (defaults to current time).
 * @returns The relative-time key plus optional ICU plural params.
 */
function relativeTime(iso: string, now = Date.now()): RelativeTime {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return { key: 'chat.relative.isoDate', params: { date: iso } };
  const diffMs = now - parsed;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'chat.relative.justNow' };
  if (min < 60) return { key: 'chat.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { key: 'chat.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'chat.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7) return { key: 'chat.relative.daysAgo', params: { count: day } };
  if (day < 30) return { key: 'chat.relative.weeksAgo', params: { count: Math.floor(day / 7) } };
  if (day < 365) return { key: 'chat.relative.monthsAgo', params: { count: Math.floor(day / 30) } };
  return {
    key: 'chat.relative.isoDate',
    params: { date: new Date(parsed).toISOString().slice(0, 10) },
  };
}

/**
 * A sentence in the list about something that did not work.
 *
 * One shape for both places it can stand -- against the row it is about, or at
 * the top when it is about the list itself or about a conversation this page
 * does not hold. Written twice at first, identically, which is two places to
 * keep in step for no reason.
 * @param root0 - The component props.
 * @param root0.text - What to say.
 * @param root0.testId - Which of the two placements this is, for tests.
 * @returns The line.
 */
function MishapLine({ text, testId }: { text: string; testId: string }): React.JSX.Element {
  return (
    <li
      className='mx-3 my-2 rounded-content-sm border border-status-error-border bg-status-error-bg px-2.5 py-1.5 text-2xs leading-relaxed text-status-error-foreground'
      role='alert'
      data-testid={testId}
    >
      {text}
    </li>
  );
}

interface RowProps {
  row: ConversationRow;
  isActive: boolean;
  onPick: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onAskDelete: (id: string) => void;
}

/**
 * One conversation in the list, with what can be done to it.
 *
 * The row is a `div` holding two siblings rather than one button holding
 * everything: the menu trigger is itself a button, and a button inside a
 * button is markup browsers rewrite, each in its own way. It is also what
 * keeps opening the menu from selecting the row -- the two presses land on
 * different elements rather than one inside the other. `SpaceDrawer` is
 * built this way for the same reasons.
 * @param root0 - The component props.
 * @param root0.row - The conversation this row shows.
 * @param root0.isActive - This is the conversation on screen.
 * @param root0.onPick - Called with the id when the row is selected.
 * @param root0.onRename - Called with the id and the name that was typed.
 * @param root0.onAskDelete - Called with the id when delete is chosen, before
 *   anything is deleted: the sheet asks first.
 * @returns The row.
 */
function ConversationRowView({
  row,
  isActive,
  onPick,
  onRename,
  onAskDelete,
}: RowProps): React.JSX.Element {
  const t = useTranslation();
  const [renaming, setRenaming] = React.useState(false);
  // Which item was chosen, held until the menu has finished closing. A ref
  // rather than state because nothing renders differently for it; see the menu
  // below for why both of them wait.
  const chose = React.useRef<'rename' | 'delete' | null>(null);
  const rel = relativeTime(row.updatedAt);

  // Focus is put in the box the moment it appears, because the reader asked
  // for it by choosing Rename -- there is nothing else they came here to do.
  // Done with a ref rather than `autoFocus`: that attribute also fires when a
  // page first loads, which is where its bad name comes from, and the rule
  // against it cannot tell the two apart.
  const box = React.useRef<HTMLInputElement>(null);
  // Where the keyboard goes when the box is gone. The box unmounts on both
  // exits -- committed or abandoned -- and an element that unmounts holding
  // the focus drops it on <body>: the reader's next Tab starts from the top
  // of the page, while they were on this row a moment ago. Measured in the
  // browser: Enter was followed by focusout to BODY and nothing caught it.
  const opener = React.useRef<HTMLButtonElement>(null);
  // Set by the two exits this row decides for itself -- Enter and Escape. A
  // blur is not one of them: the reader pressing Tab, or clicking elsewhere,
  // has already said where the keyboard should go, and taking it back would
  // make that press do nothing.
  const handBack = React.useRef(false);
  React.useEffect(() => {
    if (renaming) {
      box.current?.select();
      return;
    }
    if (!handBack.current) return;
    handBack.current = false;
    // In an effect rather than in the handler: the button is put back by the
    // render this state change causes, and it does not exist before that.
    opener.current?.focus();
  }, [renaming]);

  /**
   * Take what was typed, if it is a name at all.
   * @param typed - The contents of the box.
   * @param decidedHere - This row ended the edit itself (Enter or Escape), so
   *   the keyboard goes back to it. False when the box merely lost the focus:
   *   the reader has already said where it should go.
   */
  const commit = (typed: string, decidedHere = true): void => {
    handBack.current = decidedHere;
    setRenaming(false);
    const named = typed.trim();
    // A row showing nothing reads as a rendering fault rather than as a name,
    // so a name of nothing is not one. Same rule the server applies.
    if (named.length > 0 && named !== row.title) onRename(row.id, named);
  };

  return (
    <li role='listitem'>
      <div
        className={cn(
          // `relative` so the menu can float over the row's own region rather
          // than sit beside it. Beside it was the first cut, and it left the
          // row's padding and the gap between the two as dead strips: a press
          // on the left edge of a row, or just left of the menu, landed on the
          // container and selected nothing. Measured in the browser -- jsdom
          // has no layout, so nothing here could have caught it.
          'group relative flex items-center border-b border-border transition-colors',
          // The active row uses the accent fill, the same one hover uses.
          // `bg-muted` is a recess and made the active row darker than its
          // siblings -- `SpaceDrawer` carries the same note for the same
          // reason.
          isActive ? 'bg-accent' : 'hover:bg-accent',
        )}
        data-testid={`conversation-${row.id}`}
      >
        {renaming ? (
          <input
            data-testid='conversation-rename-input'
            ref={box}
            defaultValue={row.title ?? ''}
            // The same cap the server enforces. Without it a pasted name over
            // the limit comes back as a flat validation error that says
            // nothing about length, while the box in the header simply stops
            // taking characters -- one thing, two behaviours.
            maxLength={CONVERSATION_TITLE_MAX_CHARS}
            placeholder={t('chat.conversation.renamePlaceholder')}
            aria-label={t('chat.conversation.rename')}
            className='m-3 min-w-0 flex-1 rounded-content-sm border border-active-border bg-background px-2 py-1 text-sm text-foreground outline-none'
            // Marks what an Escape means while the focus is in here. The
            // sheet reads it before dismissing; see `onEscapeKeyDown` below.
            data-renaming
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') {
                handBack.current = true;
                setRenaming(false);
              }
            }}
            onBlur={(e) => commit(e.currentTarget.value, false)}
          />
        ) : (
          <>
            <Button
              type='button'
              variant={null}
              size={null}
              onClick={() => onPick(row.id)}
              aria-current={isActive ? 'true' : undefined}
              // The whole row, edge to edge, with room kept on the right so
              // the text never runs under the menu floating there. Pressing
              // anywhere but that menu selects the conversation.
              className='flex w-full min-w-0 items-start gap-3 py-3 pl-4 pr-12 text-left'
              ref={opener}
              data-testid={`conversation-open-${row.id}`}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                  isActive ? 'bg-foreground' : 'bg-muted-foreground/40',
                )}
              />
              <span className='flex min-w-0 flex-1 flex-col gap-1'>
                {row.title === null ? (
                  <span
                    data-testid='conversation-untitled'
                    className='truncate text-sm font-normal text-muted-foreground'
                  >
                    {t('chat.conversation.untitled')}
                  </span>
                ) : (
                  <span className='truncate text-sm font-normal text-foreground'>
                    {row.title}
                  </span>
                )}
                <span className='text-2xs tabular-nums text-muted-foreground'>
                  {t(rel.key, rel.params)}
                </span>
              </span>
            </Button>
            <div className='absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type='button'
                    variant='chrome-ghost'
                    size='chrome'
                    aria-label={t('chat.conversation.rowActions')}
                    data-testid={`conversation-menu-${row.id}`}
                  >
                    <MoreVertical className='h-4 w-4' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align='end'
                  // Asking to delete opens a dialog, and opening one from
                  // inside `onSelect` opens it into the press that is still
                  // finishing: the pointerup that chose the item carries on to
                  // the document, where a dialog mounted a moment ago reads it
                  // as a press outside itself and closes -- and the same press
                  // then reaches the sheet, which closes too. On screen it is a
                  // flicker and the conversation is still there.
                  // Rename has the same shape for a different reason: the box
                  // it opens is focused the moment it appears, and a menu still
                  // playing its exit animation still holds a focus trap -- the
                  // caret is pulled back out, and the box, which commits on
                  // blur, closes itself in the same breath. Its trigger is
                  // unmounted by then too, so there is nowhere for the focus
                  // Radix hands back to land.
                  // So the item only says what was chosen, and the doing
                  // happens here, once the menu has closed and its press is
                  // over. `preventDefault` keeps the focus from going back to
                  // the trigger -- the dialog is about to take it, or the box
                  // is. The same shape as the canvas node menu, whose rename
                  // opens an editor from this handler for the same reason.
                  onCloseAutoFocus={(event) => {
                    const what = chose.current;
                    if (what === null) return;
                    chose.current = null;
                    event.preventDefault();
                    if (what === 'delete') onAskDelete(row.id);
                    else setRenaming(true);
                  }}
                >
                  <DropdownMenuItem
                    data-testid={`conversation-rename-${row.id}`}
                    onSelect={() => {
                      chose.current = 'rename';
                    }}
                  >
                    {t('chat.conversation.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`conversation-delete-${row.id}`}
                    onSelect={() => {
                      chose.current = 'delete';
                    }}
                  >
                    {t('chat.conversation.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * Side sheet listing this reader's conversations in this project.
 *
 * Rows are ordered most recently used first, which is the order the server
 * sends them in and the order that makes the top of the list the one they
 * were in before this.
 * @param root0 - The component props.
 * @param root0.open - Whether the history sheet is open.
 * @param root0.onOpenChange - Called with the next open state when the sheet toggles.
 * @param root0.conversations - The conversations to list.
 * @param root0.activeId - The id of the currently active conversation, if any.
 * @param root0.onPick - Called with a conversation id when a row is selected.
 * @param root0.onRename - Called with an id and the name that was typed.
 * @param root0.onDelete - Called with an id once the reader has confirmed.
 * @param root0.hasMore - The project has conversations older than the ones listed.
 * @param root0.onReachEnd - Called when the reader reaches the end of what has been fetched.
 * @param root0.loadingMore - A request for the next page is out.
 * @param root0.nextPageFailed - The last attempt at the next page failed.
 * @param root0.listLoading - The first page of the list is on its way.
 * @param root0.rowMishap - What to say about one row, and which one.
 * @returns The left-side sheet listing the project's conversations.
 */
function ConversationHistorySheetInner({
  open,
  onOpenChange,
  conversations,
  activeId,
  onPick,
  onRename,
  onDelete,
  hasMore,
  onReachEnd,
  loadingMore,
  nextPageFailed,
  listLoading = false,
  rowMishap = null,
}: ConversationHistorySheetProps): React.JSX.Element {
  const t = useTranslation();
  // Which conversation the reader has asked to delete, while they are being
  // asked whether they mean it. Null the rest of the time, which is what
  // keeps the dialog closed.
  const [deleting, setDeleting] = React.useState<string | null>(null);
  // A word about one row goes against that row, and everything else goes to
  // the top. The list is one page: a rename started from the header is about
  // whichever conversation is on screen, and that one need not be on the page
  // in hand. Asking "which row is it about" instead of "is it about a row"
  // dropped those on the floor -- the reader pressed rename, is waiting to
  // hear, and nothing at all appeared.
  const mishapRow =
    rowMishap !== null && conversations.some((c) => c.id === rowMishap.conversationId)
      ? rowMishap.conversationId
      : null;

  // The confirm dialog is a sibling of the sheet, not a child, and it is
  // portalled to the body -- so closing the sheet leaves it on screen, and a
  // scrim over the column cannot cover it either. It asks about a row in a
  // list that is no longer being shown; pressing its delete would act on a
  // column that says it cannot be operated.
  React.useEffect(() => {
    if (!open) setDeleting(null);
  }, [open]);
  // The line about a page that did not arrive takes itself away. What it says
  // is an event, not a state: the reader was told, and the list in front of
  // them is unchanged and still usable. The mark in the store stays -- that is
  // what keeps the end-of-list watcher off duty until the reader scrolls
  // again, which is a different question from how long the words are up.
  const [showFailure, setShowFailure] = React.useState(false);
  React.useEffect(() => {
    if (!nextPageFailed) {
      setShowFailure(false);
      return undefined;
    }
    setShowFailure(true);
    const forgetting = setTimeout(() => setShowFailure(false), NOTICE_LINGERS_MS);
    return () => clearTimeout(forgetting);
  }, [nextPageFailed]);

  const { scrollerRef, sentinelRef } = useScrolledToEnd({
    enabled: hasMore,
    onReachEnd,
    itemCount: conversations.length,
    // After a failure the end of the list is no longer what is watched: it is
    // still in view and nothing moved it, so watching it again would ask again
    // by itself. A scroll is watched instead, which only the reader can do.
    failed: nextPageFailed,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        onPointerDownOutside={(event) => {
          if (pressedTheButtonThatOpensThisList(event.target)) event.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          // An Escape typed into a rename box means "leave the name alone",
          // not "close the list". Radix listens for it on the document in the
          // capture phase, so the box itself cannot stop it getting here --
          // it can only say what the press was for, and this is where that is
          // read. Marking it handled leaves the sheet open; the box's own
          // handler then backs the rename out.
          if (document.activeElement?.hasAttribute('data-renaming')) e.preventDefault();
        }}
        side='left-floating'
        // flex column so the header stays fixed and the ScrollArea below
        // (flex-1 min-h-0) takes exactly the remaining height (#1773).
        className='flex w-80 flex-col p-0'
        data-testid='conversation-history-sheet'
      >
        <SheetHeader className='flex flex-row items-center px-4 py-3'>
          <SheetTitle className='text-sm font-medium uppercase tracking-wide text-muted-foreground'>
            {t('chat.history.title')}
          </SheetTitle>
          <SheetDescription className='sr-only'>
            {t('chat.history.description')}
          </SheetDescription>
        </SheetHeader>
        {/* ScrollArea (#1773): overlay scrollbar — appears only while
            scrolling, no layout space, hover changes color only. The wrapper
            is what the end-of-list watcher reads the scrolling element from;
            Radix puts that one level in. */}
        <div ref={scrollerRef} className='flex min-h-0 flex-1 flex-col'>
          <ScrollArea className='min-h-0 flex-1'>
            <ul
              className='flex flex-col gap-px'
              data-testid='conversation-history-list'
              role='list'
            >
              {rowMishap !== null && mishapRow === null ? (
                <MishapLine
                  key={rowMishap.at}
                  text={rowMishap.text}
                  testId='conversation-list-mishap'
                />
              ) : null}
              {conversations.length === 0 ? (
                listLoading ? (
                  <li
                    className='px-4 py-3 text-sm text-muted-foreground'
                    data-testid='conversation-list-loading'
                  >
                    {t('chat.history.loading')}
                  </li>
                ) : (
                  <li className='px-4 py-3 text-sm text-muted-foreground'>
                    {t('chat.history.empty')}
                  </li>
                )
              ) : (
                conversations.map((c) => (
                  <React.Fragment key={c.id}>
                    <ConversationRowView
                      row={c}
                      isActive={c.id === activeId}
                      onPick={onPick}
                      onRename={onRename}
                      onAskDelete={setDeleting}
                    />
                    {rowMishap !== null && mishapRow === c.id ? (
                      <MishapLine
                        key={rowMishap.at}
                        text={rowMishap.text}
                        testId='conversation-row-mishap'
                      />
                    ) : null}
                  </React.Fragment>
                ))
              )}
            </ul>
            {/* After the last row, so coming into view means the reader has
                got to the end of what has been fetched. */}
            <div ref={sentinelRef} data-testid='conversation-list-end' />
            {/* The foot of the list says what is happening there, and there is
                nothing here to press: reaching the end is what asks for a
                page. While one is out this says so; when one does not arrive
                it says that instead, for as long as `NOTICE_LINGERS_MS`
                gives it. Then it goes, and the next scroll to the end asks
                again. */}
            {loadingMore ? (
              <p
                className='m-3 text-2xs text-muted-foreground'
                data-testid='conversation-list-loading-more'
              >
                {t('chat.history.loadingMore')}
              </p>
            ) : showFailure ? (
              <p
                className='m-3 text-2xs text-status-error'
                data-testid='conversation-list-more-failed'
              >
                {t('chat.history.moreFailed')}
              </p>
            ) : null}
          </ScrollArea>
        </div>
      </SheetContent>

      {/* Asked before anything goes, which is what this repo does with every
          destructive action -- `SpaceDrawer` deletes a Space the same way. */}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent data-testid='conversation-delete-dialog'>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.conversation.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat.conversation.deleteBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid='conversation-delete-cancel'>
              {t('chat.conversation.deleteCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid='conversation-delete-confirm'
              onClick={() => {
                if (deleting) onDelete(deleting);
                setDeleting(null);
              }}
            >
              {t('chat.conversation.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

export { relativeTime };

/**
 * Rendered again only when its own props change.
 *
 * A reply arriving token by token re-renders the panel that owns this, and
 * without this that re-render reaches here as well -- sixty times a second,
 * for a component whose props did not move. Every callback it is handed is
 * stable, which is what lets the comparison actually stop anything.
 */
export const ConversationHistorySheet = React.memo(ConversationHistorySheetInner);
