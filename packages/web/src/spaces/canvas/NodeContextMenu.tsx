// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Lock, Unlock } from 'lucide-react';
import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';

interface NodeContextMenuProps {
  /** Whether the menu is open (driven by the canvas's node right-click handler). */
  open: boolean;
  /** Viewport x of the right-click; the menu anchors here. */
  x: number;
  /** Viewport y of the right-click; the menu anchors here. */
  y: number;
  /** Current lock state of the right-clicked node — picks the lock / unlock label. */
  locked: boolean;
  /** Open-state change (Escape / outside click / selection closes it). */
  onOpenChange: (open: boolean) => void;
  /** Toggle the node's lock state. */
  onToggleLock: () => void;
}

/**
 * The right-click menu for a single canvas node. Mirrors {@link
 * CanvasContextMenu}: a controlled `DropdownMenu` anchored to a zero-size
 * element pinned at the cursor (ReactFlow's `onNodeContextMenu` gives a point,
 * not an element Radix can anchor to). For now it offers only lock / unlock;
 * more per-node actions slot in as additional items.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.locked - Current lock state, selecting the lock / unlock label + icon.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onToggleLock - Toggle the node's lock state.
 * @returns The cursor-anchored node action menu.
 */
export function NodeContextMenu({
  open,
  x,
  y,
  locked,
  onOpenChange,
  onToggleLock,
}: NodeContextMenuProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='node-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <DropdownMenuItem
          data-testid='node-menu-lock-toggle'
          onSelect={onToggleLock}
        >
          {locked ? (
            <Unlock className='mr-2 h-4 w-4' aria-hidden='true' />
          ) : (
            <Lock className='mr-2 h-4 w-4' aria-hidden='true' />
          )}
          {locked ? t('canvas.nodeMenu.unlock') : t('canvas.nodeMenu.lock')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
