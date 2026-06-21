// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Trash2 } from 'lucide-react';
import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

interface EdgeContextMenuProps {
  /** Whether the menu is open (driven by the canvas's edge right-click handler). */
  open: boolean;
  /** Viewport x of the right-click; the menu anchors here. */
  x: number;
  /** Viewport y of the right-click; the menu anchors here. */
  y: number;
  /** Open-state change (Escape / outside click / selection closes it). */
  onOpenChange: (open: boolean) => void;
  /** Delete the right-clicked edge (routed through the guarded delete path). */
  onDelete: () => void;
}

/**
 * The right-click menu for a single canvas edge (connection). Mirrors {@link
 * NodeContextMenu}: a controlled `DropdownMenu` anchored to a zero-size element
 * pinned at the cursor (ReactFlow's `onEdgeContextMenu` gives a point, not an
 * element Radix can anchor to). Offers only Delete, with the platform-aware
 * delete shortcut hint.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onDelete - Delete the right-clicked edge.
 * @returns The cursor-anchored edge action menu.
 */
export function EdgeContextMenu({
  open,
  x,
  y,
  onOpenChange,
  onDelete,
}: EdgeContextMenuProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='edge-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <DropdownMenuItem data-testid='edge-menu-delete' onSelect={onDelete}>
          <Trash2 className='mr-2 h-4 w-4' aria-hidden='true' />
          {t('canvas.edge.delete')}
          <DropdownMenuShortcut>
            {formatShortcut({ key: 'Delete' })}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
