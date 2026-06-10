// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Clock, FileText, Palette } from 'lucide-react';
import type * as React from 'react';

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
  /**
   * Whether the sheet is open. Controlled by the parent (typically via
   * `useExclusiveOverlay('space-readonly-sheet')` in ProjectPage so it
   * participates in the global single-overlay rule).
   */
  open: boolean;
  /**
   * Space being previewed. May be `null` briefly while the
   * `readOnlyViewSpaceId` carry value clears asynchronously — the
   * sheet renders a blank shell rather than unmounting so the close
   * animation stays smooth.
   */
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
 * @param root0 - Component props.
 * @param root0.open - Whether the sheet is open (controlled by the parent overlay manager).
 * @param root0.space - Space being previewed, or `null` briefly while the carry value clears.
 * @param root0.onClose - Called when the sheet requests to close.
 * @returns The right-side read-only preview sheet for the given space.
 */
export function SpaceReadOnlySheet({
  open,
  space,
  onClose,
}: SpaceReadOnlySheetProps): React.JSX.Element {
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
          <SheetTitle className='flex min-w-0 items-center gap-2 text-base font-semibold text-foreground'>
            <Icon className='h-4 w-4 text-muted-foreground' aria-hidden />
            <span className='truncate'>{space?.name ?? ''}</span>
            <span className='shrink-0 rounded-chrome bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground'>
              {meta ? t(meta.labelKey) : ''}
            </span>
            <span className='shrink-0 rounded-chrome bg-status-info-bg px-1 py-0.5 text-2xs font-medium text-status-info-foreground'>
              {t('spaces.readonly.label')}
            </span>
          </SheetTitle>
          <SheetDescription className='text-xs text-muted-foreground'>
            {t('spaces.readonly.description')}
          </SheetDescription>
        </SheetHeader>
        <div
          className='flex-1 overflow-auto p-4 text-sm text-muted-foreground'
          data-testid='space-read-only-body'
        >
          {space ? <ReadOnlyBody space={space} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Renders the per-space-type placeholder body inside the read-only sheet.
 * @param root0 - Component props.
 * @param root0.space - Space whose type selects which placeholder body to render.
 * @returns The placeholder body for the space type, or `null` for an unknown type.
 */
function ReadOnlyBody({ space }: { space: ProjectSpace }): React.JSX.Element | null {
  const t = useTranslation();
  switch (space.type) {
    case 'canvas':
      return (
        <div className='flex h-full items-center justify-center text-center'>
          <div className='max-w-[420px] rounded-lg border border-dashed border-border bg-popover px-6 py-4'>
            <strong className='block text-foreground'>
              {t('spaces.readonly.canvas.title')}
            </strong>
            <span className='text-xs'>
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
            <span className='text-xs'>
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
            <span className='text-xs'>
              {t('spaces.readonly.timeline.description')}
            </span>
          </div>
        </div>
      );
    default:
      return null;
  }
}
