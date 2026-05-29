import { Clock, FileText, Palette } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@web/components/ui/sheet';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import type { SpaceType } from '@web/spaces';
import { useTranslation } from '@web/i18n/use-translation';

interface SpaceReadOnlySheetProps {
  /** Whether the sheet is open. Controlled by the parent (typically via
   * `useExclusiveOverlay('space-readonly-sheet')` in ProjectPage so it
   * participates in the global single-overlay rule). */
  open: boolean;
  /** Space being previewed. May be `null` briefly while the
   * `readOnlyViewSpaceId` carry value clears asynchronously — the
   * sheet renders a blank shell rather than unmounting so the close
   * animation stays smooth. */
  space: ProjectSpace | null;
  onClose: () => void;
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
 * Read-only "peek" sheet for spaces not currently in the tab bar.
 *
 * Triggered from the SpaceDrawer "view" hover action when the picked
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
  open,
  space,
  onClose,
}: SpaceReadOnlySheetProps) {
  const t = useTranslation();
  const meta = space ? TYPE_META[space.type] : null;
  const Icon = meta?.icon ?? Palette;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side='right-floating'
        className='flex w-[min(720px,90vw)] flex-col p-0 sm:max-w-none'
        data-testid='space-read-only-sheet'
      >
        <SheetHeader className='flex flex-col gap-1 border-b border-border px-4 py-3 pr-14'>
          <SheetTitle className='flex min-w-0 items-center gap-2 text-[15px] font-semibold text-foreground'>
            <Icon className='h-4 w-4 text-muted-foreground' aria-hidden />
            <span className='truncate'>{space?.name ?? ''}</span>
            <span className='shrink-0 rounded-[4px] bg-muted px-1 py-0.5 text-[11px] font-medium text-muted-foreground'>
              {meta ? t(meta.labelKey) : ''}
            </span>
            <span className='shrink-0 rounded-[4px] bg-status-info-bg px-1 py-0.5 text-[11px] font-medium text-status-info-foreground'>
              {t('spaces.readonly.label')}
            </span>
          </SheetTitle>
          <SheetDescription className='text-[12px] text-muted-foreground'>
            {t('spaces.readonly.description')}
          </SheetDescription>
        </SheetHeader>
        <div
          className='flex-1 overflow-auto p-4 text-[13px] text-muted-foreground'
          data-testid='space-read-only-body'
        >
          {space ? <ReadOnlyBody space={space} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReadOnlyBody({ space }: { space: ProjectSpace }) {
  const t = useTranslation();
  switch (space.type) {
    case 'canvas':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>
              {t('spaces.readonly.canvas.title')}
            </strong>
            <span className='text-[12px]'>
              {t('spaces.readonly.canvas.description')}
            </span>
          </div>
        </div>
      );
    case 'document':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>
              {t('spaces.readonly.document.title')}
            </strong>
            <span className='text-[12px]'>
              {t('spaces.readonly.document.description')}
            </span>
          </div>
        </div>
      );
    case 'timeline':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>
              {t('spaces.readonly.timeline.title')}
            </strong>
            <span className='text-[12px]'>
              {t('spaces.readonly.timeline.description')}
            </span>
          </div>
        </div>
      );
    default:
      return null;
  }
}
