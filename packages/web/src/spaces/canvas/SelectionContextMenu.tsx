// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Copy, CopyPlus, Group, Trash2 } from 'lucide-react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

interface SelectionContextMenuProps {
  /** Whether the menu is open (driven by the canvas's selection right-click handler). */
  open: boolean;
  /** Viewport x of the right-click; the menu anchors here. */
  x: number;
  /** Viewport y of the right-click; the menu anchors here. */
  y: number;
  /** Open-state change (Escape / outside click / selection closes it). */
  onOpenChange: (open: boolean) => void;
  /** Group the current multi-selection (offered only when groupable). */
  onGroup?: () => void;
  /** Copy the selection to the clipboard. */
  onCopy?: () => void;
  /** Duplicate the selection in place. */
  onDuplicate?: () => void;
  /** Delete the selection (routed through the guarded delete path). */
  onDelete?: () => void;
}

/**
 * The right-click menu for a canvas multi-selection (2+ loose nodes): group,
 * copy, duplicate, delete. A controlled `DropdownMenu` anchored to a zero-size
 * element pinned at the cursor (ReactFlow's `onSelectionContextMenu` gives a
 * point, not an element Radix can anchor to). Each item renders only when its
 * handler is supplied, so the parent controls availability (read-only passes
 * none; group is offered only for an all-loose selection). Shortcut hints are
 * platform-aware via {@link formatShortcut}.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onGroup - Group the selection (offered only when groupable).
 * @param root0.onCopy - Copy the selection.
 * @param root0.onDuplicate - Duplicate the selection.
 * @param root0.onDelete - Delete the selection.
 * @returns The cursor-anchored selection action menu.
 */
export const SelectionContextMenu = React.memo(function SelectionContextMenu({
  open,
  x,
  y,
  onOpenChange,
  onGroup,
  onCopy,
  onDuplicate,
  onDelete,
}: SelectionContextMenuProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='selection-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        {onGroup ? (
          <>
            <DropdownMenuItem
              data-testid='selection-menu-group'
              onSelect={onGroup}
            >
              <Group className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.group.group')}
              <DropdownMenuShortcut>
                {formatShortcut({ mod: true, key: 'G' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {onCopy ? (
          <DropdownMenuItem data-testid='selection-menu-copy' onSelect={onCopy}>
            <Copy className='mr-2 h-4 w-4' aria-hidden='true' />
            {t('canvas.contextMenu.copy')}
            <DropdownMenuShortcut>
              {formatShortcut({ mod: true, key: 'C' })}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        {onDuplicate ? (
          <DropdownMenuItem
            data-testid='selection-menu-duplicate'
            onSelect={onDuplicate}
          >
            <CopyPlus className='mr-2 h-4 w-4' aria-hidden='true' />
            {t('canvas.contextMenu.duplicate')}
            <DropdownMenuShortcut>
              {formatShortcut({ mod: true, key: 'D' })}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid='selection-menu-delete'
              onSelect={onDelete}
            >
              <Trash2 className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.contextMenu.deleteSelection')}
              <DropdownMenuShortcut>
                {formatShortcut({ key: 'Delete' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
