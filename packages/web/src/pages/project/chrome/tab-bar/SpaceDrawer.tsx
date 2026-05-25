import {
  Clock,
  Eye,
  FileText,
  Lock,
  Menu,
  Palette,
  Trash2,
  Unlock,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useExclusiveOverlay } from '@/lib/use-exclusive-overlay';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import type { SpaceType } from '@/spaces';
import { useTranslation } from '@/i18n/use-translation';

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
 *                type · N nodes · @author · time
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
 *   - if Space is already in this user's openTabIds → activate that tab
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
 */
export function SpaceDrawer({
  spaces,
  openTabIds,
  activeSpaceId,
  projectId,
  onActivate,
  onView,
  onDeleteSpace,
  onSetSpaceLocked,
}: SpaceDrawerProps) {
  const t = useTranslation();
  const [open, setOpen] = useExclusiveOverlay('space-drawer');
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label={t('spaces.drawer.label')}
          data-testid='space-drawer-trigger'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <Menu className='h-[18px] w-[18px]' />
        </Button>
      </SheetTrigger>
      <SheetContent
        side='right-floating'
        // Width matches ProjectMessagesButton sheet (315px) for a
        // consistent right-floating sheet footprint across the chrome
        // (PR #138 user-driven alignment).
        className='flex w-[315px] flex-col p-0'
        data-testid='space-drawer'
      >
        <SheetHeader className='border-b border-border px-4 py-3'>
          <SheetTitle className='text-[15px] font-semibold text-foreground'>
            {t('spaces.drawer.title')}
          </SheetTitle>
          <SheetDescription className='text-[12px] text-muted-foreground'>
            {t('spaces.drawer.description', { count: spaces.length })}
          </SheetDescription>
        </SheetHeader>
        <ul
          className='flex flex-col overflow-y-auto'
          data-testid='space-drawer-list'
          role='list'
        >
          {spaces.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              {t('spaces.drawer.empty')}
            </li>
          ) : (
            spaces.map((s) => (
              <SpaceDrawerRow
                key={s.id}
                space={s}
                isActive={s.id === activeSpaceId}
                isOpen={openTabIds.includes(s.id)}
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
              />
            ))
          )}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

interface SpaceDrawerRowProps {
  space: ProjectSpace;
  isActive: boolean;
  isOpen: boolean;
  onActivate: () => void;
  onView: () => void;
  onDeleteSpace?: (spaceId: string) => Promise<void> | void;
  onSetSpaceLocked?: (spaceId: string, locked: boolean) => Promise<void> | void;
}

function SpaceDrawerRow({
  space,
  isActive,
  isOpen,
  onActivate,
  onView,
  onDeleteSpace,
  onSetSpaceLocked,
}: SpaceDrawerRowProps) {
  const t = useTranslation();
  const meta = TYPE_META[space.type];
  const Icon = meta.icon;
  const [lockBusy, setLockBusy] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const onToggleLock = async (e: React.MouseEvent) => {
    e.stopPropagation();
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

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteBusy || space.locked || !onDeleteSpace) return;
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
          'group flex items-start gap-3 border-b border-border px-4 py-3 transition-colors',
          isActive ? 'bg-accent' : 'hover:bg-muted',
        )}
        data-testid={`space-drawer-row-${space.id}`}
      >
        <button
          type='button'
          onClick={onActivate}
          aria-label={t('spaces.drawer.openAria', { name: space.name })}
          aria-current={isActive ? 'true' : undefined}
          className='flex min-w-0 flex-1 items-start gap-3 text-left'
        >
          <span className='mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-muted text-muted-foreground'>
            <Icon className='h-4 w-4' />
          </span>
          <span className='flex min-w-0 flex-1 flex-col gap-1'>
            <span className='flex items-center gap-2'>
              <span className='truncate text-[14px] font-semibold text-foreground'>
                {space.name}
              </span>
              {isActive ? (
                <span className='shrink-0 rounded-[4px] bg-status-info-bg px-1 py-0.5 text-[11px] font-medium text-status-info-foreground'>
                  {t('spaces.drawer.status.editing')}
                </span>
              ) : isOpen ? (
                <span className='shrink-0 rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
                  {t('spaces.drawer.status.open')}
                </span>
              ) : null}
              {space.locked ? (
                <Lock
                  className='shrink-0 text-muted-foreground'
                  style={{ width: 12, height: 12 }}
                  aria-label='Locked'
                />
              ) : null}
            </span>
            <span className='truncate text-[12px] text-muted-foreground'>
              {t(meta.labelKey)}
            </span>
          </span>
        </button>
        <div
          // `self-center` overrides the row's `items-start` for this one
          // child — the row keeps the icon + 2-line text top-aligned on
          // the left, while the action group (single-row, smaller height)
          // sits vertically centered in the row. Without `self-center`
          // the action buttons hugged the top edge (PR after #140 user
          // report 2026-05-25).
          className='flex shrink-0 self-center items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'
          data-testid={`space-drawer-actions-${space.id}`}
        >
          <RowAction
            label={t('spaces.drawer.action.view')}
            testId={`space-drawer-view-${space.id}`}
            onClick={onView}
          >
            <Eye className='h-4 w-4' />
          </RowAction>
          <RowAction
            label={
              space.locked
                ? t('spaces.drawer.action.unlock')
                : t('spaces.drawer.action.lock')
            }
            testId={`space-drawer-lock-${space.id}`}
            onClick={onToggleLock}
            busy={lockBusy}
          >
            {space.locked ? (
              <Unlock className='h-4 w-4' />
            ) : (
              <Lock className='h-4 w-4' />
            )}
          </RowAction>
          {space.locked ? (
            <RowAction
              label={t('spaces.drawer.action.deleteLocked')}
              testId={`space-drawer-delete-${space.id}`}
              onClick={(e) => e.stopPropagation()}
              disabled
            >
              <Trash2 className='h-4 w-4' />
            </RowAction>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <RowAction
                  label={t('spaces.drawer.action.delete')}
                  testId={`space-drawer-delete-${space.id}`}
                  onClick={(e) => e.stopPropagation()}
                  disabled={deleteBusy}
                >
                  <Trash2 className='h-4 w-4' />
                </RowAction>
              </AlertDialogTrigger>
              <AlertDialogContent
                data-testid={`space-drawer-delete-confirm-${space.id}`}
                onClick={(e) => e.stopPropagation()}
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
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
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
          )}
        </div>
      </div>
    </li>
  );
}

interface RowActionProps {
  label: string;
  testId: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  disabled?: boolean;
  busy?: boolean;
}

function RowAction({
  label,
  testId,
  onClick,
  children,
  disabled,
  busy,
}: RowActionProps) {
  // Wrap the icon button in a shadcn Tooltip (visual / timing
  // consistent with the rest of the chrome). Native `title` attribute
  // was inconsistent across OS/browsers (long delay, OS-themed bubble
  // that breaks dark mode, unreliable on touch). `aria-label` stays
  // for screen readers; TooltipContent text duplicates it for sighted
  // mouse / keyboard users (PR after #140, 2026-05-25 user ask).
  // TooltipProvider is mounted globally in App.tsx, so no per-instance
  // provider needed here.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          aria-label={label}
          onClick={onClick}
          disabled={disabled || busy}
          data-testid={testId}
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-chrome transition-colors',
            disabled
              ? 'cursor-not-allowed text-muted-foreground/40'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            busy && 'animate-pulse',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
