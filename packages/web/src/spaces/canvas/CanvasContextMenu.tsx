// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';

interface CanvasContextMenuProps {
  /** Whether the menu is open (driven by the canvas's right-click handler). */
  open: boolean;
  /** Viewport x of the right-click, the menu anchors here. */
  x: number;
  /** Viewport y of the right-click, the menu anchors here. */
  y: number;
  /** Open-state change (Escape / outside click / selection closes it). */
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen creatable node type. */
  onPick: (type: CreatableNodeType) => void;
}

/**
 * The canvas blank-area right-click menu. ReactFlow's `onPaneContextMenu`
 * gives a cursor point, which a Radix `ContextMenu` can't be anchored to
 * (it positions from its own `Trigger`'s contextmenu event). So this is a
 * controlled `DropdownMenu` anchored to a zero-size element pinned at the
 * cursor — same a11y (focus trap, arrow keys, Escape) with an arbitrary
 * drop point.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onPick - Called with the chosen creatable node type.
 * @returns The cursor-anchored creatable-node menu.
 */
export function CanvasContextMenu({
  open,
  x,
  y,
  onOpenChange,
  onPick,
}: CanvasContextMenuProps): React.JSX.Element {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='canvas-context-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <CreatableNodeMenuItems onPick={onPick} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
