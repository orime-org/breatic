// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Box,
  Clock,
  Eye,
  FileText,
  Lock,
  Menu,
  MoreVertical,
  Palette,
  Pencil,
  Trash2,
  Unlock,
} from 'lucide-react';
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
  SheetTrigger,
} from '@web/components/ui/sheet';
import { cn } from '@web/lib/utils';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { SPACE_NAME_MAX_LEN, spacesNewestFirst } from '@breatic/shared';
import { relativeTime } from '@web/pages/project/chrome/tab-bar/relative-time';
import type { SpaceType } from '@breatic/shared';
import { useTranslation } from '@web/i18n/use-translation';
import { useInlineEditExit } from '@web/lib/inline-edit-exit';
import { useHeldName } from '@web/lib/use-held-name';

interface SpaceDrawerProps {
  spaces: ReadonlyArray<ProjectSpace>;
  activeSpaceId: string;
  projectId: string;
  /** Activate a Space (opens its tab if not open + makes it active). */
  onActivate: (id: string) => void;
  /**
   * RPC handlers injected by ProjectPage (it owns the live meta-doc
   * provider). Drawer rows call these; ProjectPage routes through
   * `sendSpaceRpc`. Optional so tests / storybook can render the row
   * read-only.
   */
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
  /** Renames a Space; omitted for a viewer, whose rows then offer no Rename. */
  onRenameSpace?: (spaceId: string, name: string) => Promise<void> | void;
}

const TYPE_META: Record<
  SpaceType,
  { icon: typeof Palette; labelKey: 'spaces.kind.canvas' | 'spaces.kind.document' | 'spaces.kind.timeline' | 'spaces.kind.threeD' }
> = {
  canvas: { icon: Palette, labelKey: 'spaces.kind.canvas' },
  document: { icon: FileText, labelKey: 'spaces.kind.document' },
  timeline: { icon: Clock, labelKey: 'spaces.kind.timeline' },
  '3d': { icon: Box, labelKey: 'spaces.kind.threeD' },
};

// The row's own layout, the same whether it is the row's button or, while the
// name is being edited, a plain box (the rename box cannot sit in a button).
// Room kept on the right for the menu button floating there (32px wide, 8px
// in from the row's edge, which the row's own 16px pad already covers half
// of), plus an 8px gap: the Editing mark ends against it and the name
// truncates before it.
const ROW_BODY = 'flex min-w-0 flex-1 items-start gap-3 pr-8 text-left';

/**
 * "All Spaces" drawer — every Space in the project, with status chip,
 * metadata row, and hover actions. Mirrors user spec from image 43
 * (2026-05-21): all spaces / N entries · click to switch or use right
 * menu.
 *
 * Row anatomy:
 *
 *   [type icon]  Space name  [lock if locked]          [editing chip]
 *                when this Space was made
 *
 *   hover actions (right):
 *     [view] [rename (disabled if locked)] [lock toggle] [delete (disabled if locked)]
 *
 * Status chip (user 2026-10-14): the row of this user's active tab carries
 * an Editing chip, a neutral outline centred on the row like the type icon.
 * Every other row carries none.
 *
 * View does what pressing the row does: it opens the Space as a tab, or
 * switches to the tab it already has (user 2026-10-14, inner#1528).
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
 * @param root0.activeSpaceId - Id of this user's active space, driving the "editing" chip.
 * @param root0.onActivate - Activates a space (opens its tab and makes it active).
 * @param root0.onDeleteSpace - RPC handler to delete a space; when omitted, rows render read-only.
 * @param root0.onSetSpaceLocked - RPC handler to lock/unlock a space; when omitted, rows render read-only.
 * @param root0.onRenameSpace - RPC handler to rename a space; when omitted, rows offer no Rename.
 * @returns The "All Spaces" drawer trigger button and its sheet listing every space.
 */
export function SpaceDrawer({
  spaces,
  activeSpaceId,
  onActivate,
  onDeleteSpace,
  onSetSpaceLocked,
  onRenameSpace,
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
  const handleEscapeKeyDown = React.useCallback((event: KeyboardEvent): void => {
    // Escape inside a rename box ends the rename (the box's own handler);
    // the drawer stays. The box carries `data-renaming` for this.
    if (document.activeElement?.hasAttribute('data-renaming')) event.preventDefault();
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
        onEscapeKeyDown={handleEscapeKeyDown}
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
                  isLastSpace={spaces.length === 1}
                  onActivate={() => {
                    onActivate(s.id);
                    setOpen(false);
                  }}
                  onDeleteSpace={onDeleteSpace}
                  onSetSpaceLocked={onSetSpaceLocked}
                  onRenameSpace={onRenameSpace}
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
  /** True when this is the project's only space — its delete action is disabled. */
  isLastSpace: boolean;
  /** Opens this Space as a tab and closes the drawer; the row and View both run it. */
  onActivate: () => void;
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
  onRenameSpace?: (spaceId: string, name: string) => Promise<void> | void;
}

/**
 * A single space row in the drawer: type icon, name, status chip, and a
 * menu button, shown on hover, holding view / rename / lock / delete. Rename
 * turns the name into a box in place, as the conversation history rows do.
 * @param root0 - Component props.
 * @param root0.space - The space rendered by this row.
 * @param root0.isActive - Whether this space is the user's active tab (shows the "editing" chip).
 * @param root0.isLastSpace - Whether this is the project's only space (disables delete — projects keep >=1).
 * @param root0.onActivate - Opens this space as a tab; the row and View both run it.
 * @param root0.onDeleteSpace - RPC handler to delete this space; when omitted, the delete action is read-only.
 * @param root0.onSetSpaceLocked - RPC handler to lock/unlock this space; when omitted, the lock action is read-only.
 * @param root0.onRenameSpace - RPC handler to rename this space; when omitted, the row offers no Rename.
 * @param root0.onConfirmCloseAutoFocus - Close-focus handler for the delete-confirm dialog (#1539: drawer panel reclaims focus).
 * @returns The drawer row for the space.
 */
function SpaceDrawerRow({
  space,
  isActive,
  isLastSpace,
  onActivate,
  onDeleteSpace,
  onSetSpaceLocked,
  onRenameSpace,
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
  const [renaming, setRenaming] = React.useState(false);
  // Which item was chosen, held until the menu has finished closing; see the
  // menu's `onCloseAutoFocus` for why both of them wait.
  const chose = React.useRef<'rename' | 'delete' | null>(null);
  // The name reaches `space` once the server's write comes back through the
  // project meta, after the box has closed.
  const { shown: name, hold } = useHeldName(space.name);
  const box = React.useRef<HTMLInputElement>(null);
  const menuButton = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!renaming || !box.current) return;
    box.current.focus();
    // Selected from the end back, so the box scrolls to a long name's start.
    box.current.setSelectionRange(0, box.current.value.length, 'backward');
  }, [renaming]);

  /**
   * Takes what was typed, if it is a new name at all.
   * @param typed - The contents of the box.
   */
  const commit = (typed: string): void => {
    setRenaming(false);
    const named = typed.trim().slice(0, SPACE_NAME_MAX_LEN);
    if (named.length === 0 || named === name || !onRenameSpace) return;
    // A refused rename has already raised its toast in ProjectPage's callRpc.
    hold(named, onRenameSpace(space.id, named));
  };

  // Ending the box from the keyboard gives the keyboard to this row's menu
  // button, where the rename started; the row itself opens the Space.
  const exit = useInlineEditExit({
    editing: renaming,
    target: () => menuButton.current,
    commit: () => commit(box.current?.value ?? ''),
    cancel: () => setRenaming(false),
  });
  // Why delete is not offered, said on the greyed item. The backend refuses
  // both cases too; this keeps the action from being offered at all.
  const deleteBlocked = space.locked
    ? 'spaces.drawer.action.deleteLocked'
    : isLastSpace
      ? 'spaces.drawer.action.deleteLastSpace'
      : null;

  /** Toggles the space's locked state via `onSetSpaceLocked`. */
  const onToggleLock = async (): Promise<void> => {
    if (lockBusy || !onSetSpaceLocked) return;
    setLockBusy(true);
    try {
      await onSetSpaceLocked(space.id, !space.locked);
    } catch {
      // A refused lock has already raised its toast in ProjectPage's callRpc.
    } finally {
      setLockBusy(false);
    }
  };

  /**
   * Deletes the space via `onDeleteSpace` (no-op when locked or already busy),
   * keeping the confirm dialog open while it runs: closed on success, left
   * open on failure so it can be pressed again. The live Y.Doc update drives
   * the resulting UI changes.
   * @param e - The click event from the delete confirm action.
   */
  const onDelete = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    e.preventDefault();
    if (deleteBusy || deleteBlocked !== null || !onDeleteSpace) return;
    setDeleteBusy(true);
    try {
      await onDeleteSpace(space.id);
      setConfirmOpen(false);
      // The collab Y.Doc update will drive the spaces list shrink + the
      // ProjectPage effect picks a new active tab + clears the loading
      // overlay. Errors surface via toast inside ProjectPage.callRpc.
    } catch {
      setDeleteBusy(false);
    }
  };

  const body = (
    <>
      {/* The type icon on its own, centred on the row's two lines (user
          2026-10-14). */}
      <Icon
        className='h-5 w-5 shrink-0 self-center text-muted-foreground'
        data-testid={`space-drawer-type-icon-${space.id}`}
        aria-hidden='true'
      />
      <span className='flex min-w-0 flex-1 flex-col gap-1'>
        {/* 20px tall whatever it holds, the height the rename box takes, so a
            row being renamed stands as tall as every other row. */}
        <span className='flex min-h-5 items-center gap-2'>
          {renaming ? (
            <input
              ref={box}
              autoComplete='off'
              data-testid={`space-drawer-rename-input-${space.id}`}
              defaultValue={name}
              maxLength={SPACE_NAME_MAX_LEN}
              aria-label={t('spaces.rename.inputAriaLabel')}
              // The conversation history's rename box (28px: 18 of text, 4px
              // pad and a 1px border either side); the negative margin keeps
              // the name line at its 20px, so the row keeps its height. Shrinks
              // before the menu button the row keeps room for.
              className='-my-1 h-7 min-w-0 flex-1 rounded-content-sm border border-active-border bg-background px-2 py-1 text-sm font-normal leading-[18px] text-foreground outline-none'
              // Marks what an Escape means while the focus is in here. The
              // drawer reads it before dismissing.
              data-renaming
              onKeyDown={exit.onKeyDown}
              onCompositionEnd={exit.onCompositionEnd}
              onBlur={(e) => commit(e.currentTarget.value)}
            />
          ) : (
            <span
              // Set as the conversation history sets its names (user
              // 2026-10-14).
              className='truncate text-sm font-normal text-foreground'
              data-testid={`space-drawer-name-${space.id}`}
            >
              {name}
            </span>
          )}
          {space.locked ? (
            <Lock
              className='shrink-0 text-muted-foreground'
              style={{ width: 12, height: 12 }}
              aria-label={t('spaces.lockedAria')}
            />
          ) : null}
        </span>
        <span className='truncate text-2xs tabular-nums text-muted-foreground'>
          {t(made.key, made.params)}
        </span>
      </span>
      {/* Centred on the row's two lines like the type icon, at the right end
          against the room kept for the menu button (user 2026-10-14). */}
      {isActive ? (
        <span className='ml-auto shrink-0 self-center rounded-chrome border border-border px-1 py-px text-2xs font-medium text-foreground-secondary'>
          {t('spaces.drawer.status.editing')}
        </span>
      ) : null}
    </>
  );

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
        {renaming ? (
          // The box cannot sit inside the row's button, so while renaming the
          // row is laid out the same way without one.
          <div className={ROW_BODY}>{body}</div>
        ) : (
          <Button
            variant={null}
            size={null}
            type='button'
            onClick={onActivate}
            aria-label={t('spaces.drawer.openAria', { name })}
            aria-current={isActive ? 'true' : undefined}
            className={ROW_BODY}
          >
            {body}
          </Button>
        )}
        <div
          // Out of the flow and over the room the row button keeps free on
          // its right (`pr-8`), so the name truncates before it rather than
          // running under it. Shown while the row is hovered, while focus is
          // inside it, while its menu is open and while its name is being
          // renamed.
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
            menuOpen || renaming ? 'opacity-100' : 'opacity-0',
          )}
          data-testid={`space-drawer-actions-${space.id}`}
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                ref={menuButton}
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
              // Asking to delete opens a dialog, and asking to rename opens a
              // box. Opened from `onSelect`, the dialog would mount into the
              // press still finishing, read it as a press outside itself and
              // close, and the box would lose its focus to the trigger the
              // menu hands it back to. So the item only records the choice and
              // the dialog or box opens here, once the menu has closed;
              // `preventDefault` keeps the focus off the trigger. The same
              // shape as the conversation history rows.
              onCloseAutoFocus={(event) => {
                const choice = chose.current;
                if (choice === null) return;
                chose.current = null;
                event.preventDefault();
                if (choice === 'delete') setConfirmOpen(true);
                else setRenaming(true);
              }}
            >
              <DropdownMenuItem
                data-testid={`space-drawer-view-${space.id}`}
                onSelect={onActivate}
              >
                <Eye className='mr-2 h-4 w-4' aria-hidden='true' />
                {t('spaces.drawer.action.view')}
              </DropdownMenuItem>
              {onRenameSpace ? (
                <DropdownMenuItem
                  data-testid={`space-drawer-rename-${space.id}`}
                  disabled={space.locked}
                  // Greyed with the not-allowed cursor while locked, saying
                  // why underneath, as Delete does.
                  className='items-start data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed'
                  onSelect={() => {
                    chose.current = 'rename';
                  }}
                >
                  <Pencil className='mr-2 mt-0.5 h-4 w-4' aria-hidden='true' />
                  <span className='flex flex-col'>
                    {t('spaces.drawer.action.rename')}
                    {space.locked ? (
                      <span className='text-2xs text-muted-foreground'>
                        {t('spaces.drawer.action.renameLocked')}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              ) : null}
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
                // Red while it is on offer, as every delete is; greyed with
                // the not-allowed cursor when it is not (the primitive turns
                // pointer events off on a disabled item).
                className={cn(
                  'items-start data-[disabled]:pointer-events-auto data-[disabled]:cursor-not-allowed',
                  deleteBlocked === null && 'text-status-error-foreground',
                )}
                onSelect={() => {
                  chose.current = 'delete';
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
                  loading={deleteBusy}
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
