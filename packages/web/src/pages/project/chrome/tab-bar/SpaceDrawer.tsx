import {
  Clock,
  Eye,
  FileText,
  Lock,
  Menu,
  Palette,
  Unlock,
  X,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { spacesApi } from '@/data/api';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import type { SpaceType } from '@/spaces';
import { useUIStore } from '@/stores';

interface SpaceDrawerProps {
  spaces: ReadonlyArray<ProjectSpace>;
  openTabIds: ReadonlyArray<string>;
  activeSpaceId: string;
  projectId: string;
  /** Activate a Space (opens its tab if not open + makes it active). */
  onActivate: (id: string) => void;
  /** Open a Space in the read-only preview sheet (used for "查看"). */
  onView: (id: string) => void;
}

const TYPE_META: Record<
  SpaceType,
  { icon: typeof Palette; label: string }
> = {
  canvas: { icon: Palette, label: '画布' },
  document: { icon: FileText, label: '文档' },
  timeline: { icon: Clock, label: '时间线' },
};

/**
 * "All Spaces" drawer — every Space in the project, with status chip,
 * metadata row, and hover actions. Mirrors user spec from image 43
 * (2026-05-21): "所有工作面 / 10 个 · 点击切换或右侧操作".
 *
 * Row anatomy:
 *
 *   ┌─[type icon]  Space name  [editing / opened chip] [lock 🔒 if locked]
 *   │              type · N 节点 · @author · time
 *   │
 *   │  hover actions (right):
 *   │    [👁 view] [🔒 lock toggle] [✖ delete (disabled if locked)]
 *
 * Status chip (decision B.1):
 *   - 编辑中  → bg-status-info  (this user's active tab)
 *   - 已打开  → bg-muted        (this user's open tab, not active)
 *   - (none)  → no chip         (Space exists but this user hasn't opened it)
 *
 * View action (decision E.1):
 *   - if Space is already in this user's openTabIds → activate that tab
 *     (no read-only sheet — they have it open for editing)
 *   - otherwise → open the read-only preview sheet (browse + copy,
 *     no edit)
 *
 * Lock action (decision H + I.2):
 *   - calls `spacesApi.setLocked` HTTP; server publishes
 *     `space:locked` event; collab mutates Y.Doc; this drawer sees
 *     the update via the live `spaces` array. Inline spinner during
 *     the round trip (decision L.1 — quick op uses inline, not
 *     full-screen overlay).
 *
 * Delete action (decision K.1):
 *   - calls `spacesApi.delete` HTTP; server soft-deletes the
 *     yjs_documents row + publishes `space:deleted` event; collab
 *     removes from meta.spaces; full-screen overlay (decision L.1)
 *     during the round trip.
 *   - disabled when the Space is locked.
 */
export function SpaceDrawer({
  spaces,
  openTabIds,
  activeSpaceId,
  projectId,
  onActivate,
  onView,
}: SpaceDrawerProps) {
  const [open, setOpen] = React.useState(false);
  const setSpaceOpInProgress = useUIStore((s) => s.setSpaceOpInProgress);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant='chrome-ghost'
          size='chrome'
          aria-label='所有工作面'
          data-testid='space-drawer-trigger'
          style={{ height: 'var(--btn-chrome)', width: 'var(--btn-chrome)' }}
        >
          <Menu className='h-[18px] w-[18px]' />
        </Button>
      </SheetTrigger>
      <SheetContent
        side='right-floating'
        className='flex w-[min(420px,90vw)] flex-col p-0 sm:max-w-none'
        data-testid='space-drawer'
      >
        <SheetHeader className='border-b border-border px-4 py-3'>
          <SheetTitle className='text-[15px] font-semibold text-foreground'>
            所有工作面
          </SheetTitle>
          <p className='text-[12px] text-muted-foreground'>
            {spaces.length} 个 · 点击切换或右侧操作
          </p>
        </SheetHeader>
        <ul
          className='flex flex-col overflow-y-auto'
          data-testid='space-drawer-list'
          role='list'
        >
          {spaces.length === 0 ? (
            <li className='px-4 py-3 text-[13px] text-muted-foreground'>
              暂无工作面
            </li>
          ) : (
            spaces.map((s) => (
              <SpaceDrawerRow
                key={s.id}
                space={s}
                isActive={s.id === activeSpaceId}
                isOpen={openTabIds.includes(s.id)}
                projectId={projectId}
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
                onDeleted={() => setSpaceOpInProgress('deleting')}
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
  projectId: string;
  onActivate: () => void;
  onView: () => void;
  onDeleted: () => void;
}

function SpaceDrawerRow({
  space,
  isActive,
  isOpen,
  projectId,
  onActivate,
  onView,
  onDeleted,
}: SpaceDrawerRowProps) {
  const meta = TYPE_META[space.type];
  const Icon = meta.icon;
  const [lockBusy, setLockBusy] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const onToggleLock = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (lockBusy) return;
    setLockBusy(true);
    try {
      await spacesApi.setLocked(projectId, space.id, !space.locked);
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      toast.error(space.locked ? '解锁失败' : '加锁失败', {
        description: message,
      });
    } finally {
      setLockBusy(false);
    }
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteBusy || space.locked) return;
    setDeleteBusy(true);
    onDeleted();
    try {
      await spacesApi.delete(projectId, space.id);
      // The collab Y.Doc update will drive the spaces list shrink + the
      // ProjectPage effect will pick a new active tab + clear the
      // loading overlay.
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      toast.error('删除失败', { description: message });
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
          aria-label={`打开 ${space.name}`}
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
                  编辑中
                </span>
              ) : isOpen ? (
                <span className='shrink-0 rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
                  已打开
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
              {meta.label}
            </span>
          </span>
        </button>
        <div
          className='flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'
          data-testid={`space-drawer-actions-${space.id}`}
        >
          <RowAction
            label='查看'
            testId={`space-drawer-view-${space.id}`}
            onClick={onView}
          >
            <Eye className='h-4 w-4' />
          </RowAction>
          <RowAction
            label={space.locked ? '解锁' : '加锁'}
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
          <RowAction
            label={space.locked ? '锁住的工作面无法删除' : '删除'}
            testId={`space-drawer-delete-${space.id}`}
            onClick={onDelete}
            disabled={space.locked || deleteBusy}
          >
            <X className='h-4 w-4' />
          </RowAction>
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
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
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
  );
}
