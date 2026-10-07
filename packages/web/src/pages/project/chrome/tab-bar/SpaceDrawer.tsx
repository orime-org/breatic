// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Clock,
  Eye,
  FileText,
  Lock,
  Menu,
  MoreVertical,
  Palette,
  Trash2,
  Unlock,
} from 'lucide-react';
import * as React from 'react';
import { toast } from '@web/lib/toast';

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
  SheetTrigger,
} from '@web/components/ui/sheet';
import { cn } from '@web/lib/utils';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { spacesNewestFirst } from '@breatic/shared';
import { relativeTime } from '@web/pages/project/chrome/tab-bar/relative-time';
import type { SpaceType } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';

interface SpaceDrawerProps {
  spaces: ReadonlyArray<ProjectSpace>;
  openTabIds: ReadonlyArray<string>;
  activeSpaceId: string;
  projectId: string;
  /** Activate a Space (opens its tab if not open + makes it active). */
  onActivate: (id: string) => void;
  /** Open a Space in the read-only preview sheet (used for the "view" action). */
  onView: (id: string) => void;
  /**
   * RPC handlers injected by ProjectPage (it owns the live meta-doc
   * provider). Drawer rows call these; ProjectPage routes through
   * `sendSpaceRpc`. Optional so tests / storybook can render the row
   * read-only.
   */
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
}

const TYPE_META: Record<
  SpaceType,
  { icon: typeof Palette; labelKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline' }
> = {
  canvas: { icon: Palette, labelKey: 'spaces.kind.canvas' },
  document: { icon: FileText, labelKey: 'spaces.kind.document' },
  timeline: { icon: Clock, labelKey: 'spaces.kind.timeline' },
};

/**
 * "All Spaces" drawer — every Space in the project, with status chip,
 * metadata row, and hover actions. Mirrors user spec from image 43
 * (2026-05-21): all spaces / N entries · click to switch or use right
 * menu.
 *
 * Row anatomy:
 *
 *   [type icon]  Space name  [editing / open chip] [lock if locked]
 *                when this Space was made
 *
 *   hover actions (right):
 *     [view] [lock toggle] [delete (disabled if locked)]
 *
 * Status chip (decision B.1):
 *   - editing → bg-status-info  (this user's active tab)
 *   - open    → bg-muted        (this user's open tab, not active)
 *   - (none)  → no chip         (Space exists but this user hasn't opened it)
 *
 * View action (decision E.1):
 *   - if the Space is already on the strip → activate that tab
 *     (no read-only sheet — they have it open for editing)
 *   - otherwise → open the read-only preview sheet (browse + copy,
 *     no edit)
 *
 * Lock + Delete actions (ADR 2026-05-23 yjs-collab-only-write-authz):
 *   - Both round-trip via `sendSpaceRpc` (caller: ProjectPage). The
 *     collab process authorizes the role + applies the privileged Yjs
 *     write; this drawer reflects the result via the live `spaces`
 *     array. Lock uses inline spinner (quick op); delete uses the
 *     full-screen overlay owned by ProjectPage.
 *   - Delete is disabled when the Space is locked.
 * @param root0 - Component props.
 * @param root0.spaces - All spaces in the project to list in the drawer.
 * @param root0.openTabIds - Ids of the Spaces currently on the strip.
 * @param root0.activeSpaceId - Id of this user's active space, driving the "editing" chip.
 * @param root0.onActivate - Activates a space (opens its tab and makes it active).
 * @param root0.onView - Opens a space in the read-only preview sheet.
 * @param root0.onDeleteSpace - RPC handler to delete a space; when omitted, rows render read-only.
 * @param root0.onSetSpaceLocked - RPC handler to lock/unlock a space; when omitted, rows render read-only.
 * @returns The "All Spaces" drawer trigger button and its sheet listing every space.
 */
export function SpaceDrawer({
  spaces,
  openTabIds,
  activeSpaceId,
  onActivate,
  onView,
  onDeleteSpace,
  onSetSpaceLocked,
}: SpaceDrawerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('space-drawer');
  const sheetContentRef = React.useRef<HTMLDivElement>(null);
  const handleConfirmCloseAutoFocus = React.useCallback((event: Event): void => {
    // #1539: keep the keyboard user in the work surface - the drawer panel
    // (tabindex=-1 via Radix) reclaims focus instead of Radix's default
    // return-to-trigger, which fails here and dropped focus on <body>.
    event.preventDefault();
    sheetContentRef.current?.focus();
  }, []);
  return (
    <Sheet open={open} onOpenChange={setOpen} modal>
      <SheetTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('spaces.drawer.label')}
          data-testid='space-drawer-trigger'
          className='w-auto gap-1.5 px-2'
          style={{ height: 'var(--btn-chrome)' }}
        >
          <Menu className='h-[18px] w-[18px]' />
          {/* Arriving at a project opens one tab whatever the project
              holds, so the strip alone cannot say whether there is
              anything else behind this button (user 2026-09-12). */}
          <span className='text-xs tabular-nums'>{spaces.length}</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        ref={sheetContentRef}
        side='right-floating'
        withOverlay
        // Width matches ProjectActivityButton sheet (315px) for a
        // consistent right-floating sheet footprint across the chrome
        // (PR #138 user-driven alignment).
        className='flex w-[315px] flex-col p-0'
        data-testid='space-drawer'
      >
        <SheetHeader className='border-b border-border px-4 py-3'>
          <SheetTitle className='text-base font-semibold text-foreground'>
            {t('spaces.drawer.title')}
          </SheetTitle>
          <SheetDescription className='text-xs text-muted-foreground'>
            {t('spaces.drawer.description', { count: spaces.length })}
          </SheetDescription>
        </SheetHeader>
        {/* ScrollArea (#1773): overlay scrollbar — appears only while
            scrolling, no layout space, hover changes color only. */}
        <ScrollArea className='min-h-0 flex-1'>
          <ul
            className='flex flex-col gap-0.5 px-2 py-2'
            data-testid='space-drawer-list'
            role='list'
          >
            {spaces.length === 0 ? (
              <li className='px-4 py-3 text-sm text-muted-foreground'>
                {t('spaces.drawer.empty')}
              </li>
            ) : (
              spacesNewestFirst(spaces).map((s) => (
                <SpaceDrawerRow
                  key={s.id}
                  space={s}
                  isActive={s.id === activeSpaceId}
                  isOpen={openTabIds.includes(s.id)}
                  isLastSpace={spaces.length === 1}
                  onActivate={() => {
                    onActivate(s.id);
                    setOpen(false);
                  }}
                  onView={() => {
                    if (openTabIds.includes(s.id)) {
                      onActivate(s.id);
                      setOpen(false);
                    } else {
                      onView(s.id);
                      setOpen(false);
                    }
                  }}
                  onDeleteSpace={onDeleteSpace}
                  onSetSpaceLocked={onSetSpaceLocked}
                  onConfirmCloseAutoFocus={handleConfirmCloseAutoFocus}
                />
              ))
            )}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

interface SpaceDrawerRowProps {
  /**
   * #1539: the delete-confirm dialog's close-focus handler. Radix's default
   * return target is the hover-revealed row trigger, which fails for a modal
   * dialog inside a non-modal sheet (and the trigger is GONE after a
   * confirmed delete) - focus fell to <body>. The drawer panel reclaims it.
   */
  onConfirmCloseAutoFocus: (event: Event) => void;
  space: ProjectSpace;
  isActive: boolean;
  isOpen: boolean;
  /** True when this is the project's only space — its delete action is disabled. */
  isLastSpace: boolean;
  onActivate: () => void;
  onView: () => void;
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
}

/**
 * A single space row in the drawer: type icon, name, status chip, and a
 * menu button, shown on hover, holding view / lock / delete.
 * @param root0 - Component props.
 * @param root0.space - The space rendered by this row.
 * @param root0.isActive - Whether this space is the user's active tab (shows the "editing" chip).
 * @param root0.isOpen - Whether this space is open as one of the user's tabs (shows the "open" chip).
 * @param root0.isLastSpace - Whether this is the project's only space (disables delete — projects keep >=1).
 * @param root0.onActivate - Activates this space.
 * @param root0.onView - Opens this space (read-only preview, or activates if already open).
 * @param root0.onDeleteSpace - RPC handler to delete this space; when omitted, the delete action is read-only.
 * @param root0.onSetSpaceLocked - RPC handler to lock/unlock this space; when omitted, the lock action is read-only.
 * @param root0.onConfirmCloseAutoFocus - Close-focus handler for the delete-confirm dialog (#1539: drawer panel reclaims focus).
 * @returns The drawer row for the space.
 */
function SpaceDrawerRow({
  space,
  isActive,
  isOpen,
  isLastSpace,
  onActivate,
  onView,
  onDeleteSpace,
  onSetSpaceLocked,
  onConfirmCloseAutoFocus,
}: SpaceDrawerRowProps): React.JSX.Element {
  const t = useTranslation();
  const meta = TYPE_META[space.type];
  const Icon = meta.icon;
  // When the Space was made. The type word this line used to carry is what
  // the icon beside it already draws, so two Spaces of one type read the same
  // once their names truncate. `createdAt` is also what the list is ordered
  // by, so the line says where the row sits (user 2026-09-12).
  const made = relativeTime(space.createdAt ?? Number.NaN);
  const [lockBusy, setLockBusy] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const choseDelete = React.useRef(false);
  // Why delete is not offered, said on the greyed item. The backend refuses
  // both cases too; this keeps the action from being offered at all.
  const deleteBlocked = space.locked
    ? 'spaces.drawer.action.deleteLocked'
    : isLastSpace
      ? 'spaces.drawer.action.deleteLastSpace'
      : null;

  /**
   * Toggles the space's locked state via `onSetSpaceLocked`, surfacing a
   * toast on failure.
   */
  const onToggleLock = async (): Promise<void> => {
    if (lockBusy || !onSetSpaceLocked) return;
    setLockBusy(true);
    try {
      await onSetSpaceLocked(space.id, !space.locked);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t('spaces.drawer.action.operationFail');
      toast.error(
        space.locked
          ? t('spaces.drawer.action.unlockFail')
          : t('spaces.drawer.action.lockFail'),
        {
          description: message,
        },
      );
    } finally {
      setLockBusy(false);
    }
  };

  /**
   * Deletes the space via `onDeleteSpace` (no-op when locked or already busy);
   * the live Y.Doc update drives the resulting UI changes.
   * @param e - The click event from the delete confirm action.
   */
  const onDelete = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (deleteBusy || deleteBlocked !== null || !onDeleteSpace) return;
    setDeleteBusy(true);
    try {
      await onDeleteSpace(space.id);
      // The collab Y.Doc update will drive the spaces list shrink + the
      // ProjectPage effect picks a new active tab + clears the loading
      // overlay. Errors surface via toast inside ProjectPage.callRpc.
    } catch {
      setDeleteBusy(false);
    }
  };

  return (
    <li role='listitem'>
      <div
        className={cn(
          // A row is one thing, so it is drawn as one: its own rounded fill
          // rather than a band reaching both walls, and no rule between it and
          // the next — the gap is what separates them (user 2026-09-12; the
          // conversation list has drawn its rows this way since #212).
          'group relative flex items-start gap-3 rounded-chrome px-4 py-3 transition-colors',
          // The selected row sits one step past the fill its siblings take
          // under the pointer, so landing on a neighbour never draws what the
          // mark draws (tokens.css: muted is a RECESS fill that made the
          // active row darker than its siblings).
          isActive ? 'bg-accent-strong' : 'hover:bg-accent',
        )}
        data-testid={`space-drawer-row-${space.id}`}
      >
        <Button
          variant={null}
          size={null}
          type='button'
          onClick={onActivate}
          aria-label={t('spaces.drawer.openAria', { name: space.name })}
          aria-current={isActive ? 'true' : undefined}
          // `justify-start` restates the left alignment the row had before the
          // primitive's `justify-center` arrived with it.
          // Room kept on the right for the menu button floating there, so the
          // name truncates before it.
          className='flex min-w-0 flex-1 items-start gap-3 pr-12 text-left'
        >
          <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-chrome bg-muted text-muted-foreground'>
            <Icon className='h-4 w-4' />
          </span>
          <span className='flex min-w-0 flex-1 flex-col gap-1'>
            <span className='flex items-center gap-2'>
              <span className='truncate text-base font-semibold text-foreground'>
                {space.name}
              </span>
              {isActive ? (
                <span className='shrink-0 rounded-chrome bg-status-info-bg px-1 py-0.5 text-2xs font-medium text-status-info-foreground'>
                  {t('spaces.drawer.status.editing')}
                </span>
              ) : isOpen ? (
                <span className='shrink-0 rounded-chrome bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground'>
                  {t('spaces.drawer.status.open')}
                </span>
              ) : null}
              {space.locked ? (
                <Lock
                  className='shrink-0 text-muted-foreground'
                  style={{ width: 12, height: 12 }}
                  aria-label={t('spaces.lockedAria')}
                />
              ) : null}
            </span>
            <span className='truncate text-xs tabular-nums text-muted-foreground'>
              {t(made.key, made.params)}
            </span>
          </span>
        </Button>
        <div
          // Out of the flow and over the room the row button keeps free on
          // its right (`pr-12`), so the name truncates before it rather than
          // running under it. Shown while the row is hovered, while focus is
          // inside it, and while its menu is open.
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
            menuOpen ? 'opacity-100' : 'opacity-0',
          )}
          data-testid={`space-drawer-actions-${space.id}`}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type='button'
                variant='chrome-ghost'
                size='chrome'
                aria-label={t('spaces.drawer.rowActions')}
                data-testid={`space-drawer-menu-${space.id}`}
              >
                <MoreVertical className='h-4 w-4' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align='end'
              // Asking to delete opens a dialog. Opened from `onSelect`, it
              // would mount into the press still finishing, read it as a
              // press outside itself and close. So the item only records the
              // choice and the dialog opens here, once the menu has closed;
              // `preventDefault` keeps the focus off the trigger the dialog is
              // about to take it from. The same shape as the conversation
              // history rows.
              onCloseAutoFocus={(event) => {
                if (!choseDelete.current) return;
                choseDelete.current = false;
                event.preventDefault();
                setConfirmOpen(true);
              }}
            >
              <DropdownMenuItem
                data-testid={`space-drawer-view-${space.id}`}
                onSelect={onView}
              >
                <Eye className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('spaces.drawer.action.view')}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`space-drawer-lock-${space.id}`}
                disabled={lockBusy}
                onSelect={() => void onToggleLock()}
              >
                {space.locked ? (
                  <Unlock className='mr-2 h-4 w-4' aria-hidden='true' />
                ) : (
                  <Lock className='mr-2 h-4 w-4' aria-hidden='true' />
                )}
                {space.locked
                  ? t('spaces.drawer.action.unlock')
                  : t('spaces.drawer.action.lock')}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid={`space-drawer-delete-${space.id}`}
                disabled={deleteBlocked !== null || deleteBusy}
                // A greyed item still shows the not-allowed cursor; the
                // primitive turns pointer events off on a disabled item.
                className='items-start data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                onSelect={() => {
                  choseDelete.current = true;
                }}
              >
                <Trash2 className='mr-2 mt-0.5 h-4 w-4' aria-hidden='true' />
                <span className='flex flex-col'>
                  {t('spaces.drawer.action.delete')}
                  {deleteBlocked !== null ? (
                    <span className='text-2xs text-muted-foreground'>
                      {t(deleteBlocked)}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent
              data-testid={`space-drawer-delete-confirm-${space.id}`}
              onClick={(e) => e.stopPropagation()}
              onCloseAutoFocus={onConfirmCloseAutoFocus}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('spaces.drawer.action.deleteConfirmTitle', {
                    name: space.name,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('spaces.drawer.action.deleteConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  variant='destructive'
                  onClick={onDelete}
                  data-testid={`space-drawer-delete-confirm-action-${space.id}`}
                >
                  {t('spaces.drawer.action.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </li>
  );
}
