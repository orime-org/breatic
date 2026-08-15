// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { MoreVertical, Plus } from 'lucide-react';
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
import { useTranslation } from '@web/i18n/use-translation';

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
  onStartNew: () => void;
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
  const rel = relativeTime(row.updatedAt);

  // Focus is put in the box the moment it appears, because the reader asked
  // for it by choosing Rename -- there is nothing else they came here to do.
  // Done with a ref rather than `autoFocus`: that attribute also fires when a
  // page first loads, which is where its bad name comes from, and the rule
  // against it cannot tell the two apart.
  const box = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (renaming) box.current?.select();
  }, [renaming]);

  /**
   * Take what was typed, if it is a name at all.
   * @param typed - The contents of the box.
   */
  const commit = (typed: string): void => {
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
            placeholder={t('chat.conversation.renamePlaceholder')}
            aria-label={t('chat.conversation.rename')}
            className='m-3 min-w-0 flex-1 rounded-content-sm border border-active-border bg-background px-2 py-1 text-sm text-foreground outline-none'
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => commit(e.currentTarget.value)}
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
                    className='truncate text-base font-semibold text-muted-foreground'
                  >
                    {t('chat.conversation.untitled')}
                  </span>
                ) : (
                  <span className='truncate text-base font-semibold text-foreground'>
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
                    aria-label={t('chat.conversation.rename')}
                    data-testid={`conversation-menu-${row.id}`}
                  >
                    <MoreVertical className='h-4 w-4' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end'>
                  <DropdownMenuItem
                    data-testid={`conversation-rename-${row.id}`}
                    onSelect={() => setRenaming(true)}
                  >
                    {t('chat.conversation.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`conversation-delete-${row.id}`}
                    onSelect={() => onAskDelete(row.id)}
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
 * @param root0.onStartNew - Called when the reader asks for another conversation.
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
  onStartNew,
}: ConversationHistorySheetProps): React.JSX.Element {
  const t = useTranslation();
  // Which conversation the reader has asked to delete, while they are being
  // asked whether they mean it. Null the rest of the time, which is what
  // keeps the dialog closed.
  const [deleting, setDeleting] = React.useState<string | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='left-floating'
        // flex column so the header stays fixed and the ScrollArea below
        // (flex-1 min-h-0) takes exactly the remaining height (#1773).
        className='flex w-80 flex-col p-0'
        data-testid='conversation-history-sheet'
      >
        <SheetHeader className='flex flex-row items-center justify-between px-4 py-3'>
          <SheetTitle className='text-sm font-medium uppercase tracking-wide text-muted-foreground'>
            {t('chat.history.title')}
          </SheetTitle>
          <SheetDescription className='sr-only'>
            {t('chat.history.description')}
          </SheetDescription>
          <Button
            type='button'
            variant='chrome-ghost'
            size='chrome'
            aria-label={t('chat.conversation.startNew')}
            onClick={onStartNew}
            data-testid='conversation-start-new'
          >
            <Plus className='h-4 w-4' />
          </Button>
        </SheetHeader>
        {/* ScrollArea (#1773): overlay scrollbar — appears only while
            scrolling, no layout space, hover changes color only. */}
        <ScrollArea className='min-h-0 flex-1'>
          <ul
            className='flex flex-col gap-px'
            data-testid='conversation-history-list'
            role='list'
          >
            {conversations.length === 0 ? (
              <li className='px-4 py-3 text-sm text-muted-foreground'>
                {t('chat.history.empty')}
              </li>
            ) : (
              conversations.map((c) => (
                <ConversationRowView
                  key={c.id}
                  row={c}
                  isActive={c.id === activeId}
                  onPick={onPick}
                  onRename={onRename}
                  onAskDelete={setDeleting}
                />
              ))
            )}
          </ul>
        </ScrollArea>
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
