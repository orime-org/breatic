import { Clock, FileText, Palette, X } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ProjectSpace } from '@/data/yjs/project-meta';
import type { SpaceType } from '@/spaces';

interface SpaceReadOnlySheetProps {
  space: ProjectSpace | null;
  onClose: () => void;
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
 * Read-only "peek" sheet for spaces not currently in the tab bar.
 *
 * Triggered from the SpaceDrawer "查看" hover action when the picked
 * space is NOT already open in the tab bar. The sheet lets the user
 * browse, zoom, and copy content from another space without opening
 * an editable tab. If the space is already open in the tab bar, the
 * caller switches to that tab instead (no sheet).
 *
 * PR 4 ships the chrome shell + a placeholder body per space type;
 * the actual read-only renderers (ReactFlow viewer / TipTap viewer /
 * timeline viewer) land when each space type's full implementation
 * arrives in later PRs.
 */
export function SpaceReadOnlySheet({
  space,
  onClose,
}: SpaceReadOnlySheetProps) {
  const open = space !== null;
  const meta = space ? TYPE_META[space.type] : null;
  const Icon = meta?.icon ?? Palette;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side='right'
        className='flex w-[min(720px,90vw)] flex-col p-0 sm:max-w-none'
        data-testid='space-read-only-sheet'
      >
        <SheetHeader className='flex flex-row items-start justify-between gap-4 border-b border-border px-4 py-3'>
          <div className='flex min-w-0 flex-col gap-1'>
            <SheetTitle className='flex items-center gap-2 text-[15px] font-semibold text-foreground'>
              <Icon className='h-4 w-4 text-muted-foreground' aria-hidden />
              <span className='truncate'>{space?.name ?? ''}</span>
              <span className='shrink-0 rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
                {meta?.label ?? ''}
              </span>
              <span className='shrink-0 rounded-[4px] bg-status-info-bg px-1 py-0.5 text-[11px] font-medium text-status-info-foreground'>
                只读
              </span>
            </SheetTitle>
            <p className='text-[12px] text-muted-foreground'>
              此 Space 未在标签栏打开;只读预览,可缩放与复制内容,不可编辑。
            </p>
          </div>
          <button
            type='button'
            onClick={onClose}
            aria-label='关闭只读预览'
            data-testid='space-read-only-close'
            className='inline-flex h-[var(--btn-chrome)] w-[var(--btn-chrome)] shrink-0 items-center justify-center rounded-chrome text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            <X className='h-[18px] w-[18px]' />
          </button>
        </SheetHeader>
        <div
          className='flex-1 overflow-auto p-4 text-[13px] text-muted-foreground'
          data-testid='space-read-only-body'
        >
          {space ? (
            <ReadOnlyBody space={space} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReadOnlyBody({ space }: { space: ProjectSpace }) {
  switch (space.type) {
    case 'canvas':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>只读画布</strong>
            <span className='text-[12px]'>
              真实 ReactFlow viewer 在 canvas-space 完整实现时接入;
              此处展示节点与边的只读快照,支持缩放与复制。
            </span>
          </div>
        </div>
      );
    case 'document':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>只读文档</strong>
            <span className='text-[12px]'>
              TipTap 只读 viewer 在 document-space 实施时接入;
              此处展示富文本快照,支持复制段落。
            </span>
          </div>
        </div>
      );
    case 'timeline':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>只读时间线</strong>
            <span className='text-[12px]'>
              Timeline viewer 在 timeline-space 实施时接入;
              此处展示轨道快照,支持复制片段。
            </span>
          </div>
        </div>
      );
    default:
      return null;
  }
}
