// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Clipboard } from 'lucide-react';
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
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';

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
  /** Paste clipboard nodes / text at the cursor. Omit to hide the Paste item. */
  onPaste?: () => void;
}

/**
 * The canvas blank-area right-click menu. ReactFlow's `onPaneContextMenu`
 * gives a cursor point, which a Radix `ContextMenu` can't be anchored to
 * (it positions from its own `Trigger`'s contextmenu event). So this is a
 * controlled `DropdownMenu` anchored to a zero-size element pinned at the
 * cursor — same a11y (focus trap, arrow keys, Escape) with an arbitrary
 * drop point. Offers: create a node (the 4 generative types), then Paste.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onPick - Called with the chosen creatable node type.
 * @param root0.onPaste - Paste clipboard nodes / text at the cursor.
 * @returns The cursor-anchored creatable-node + paste menu.
 */
export const CanvasContextMenu = React.memo(function CanvasContextMenu({
  open,
  x,
  y,
  onOpenChange,
  onPick,
  onPaste,
}: CanvasContextMenuProps): React.JSX.Element {
  const t = useTranslation();
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
        {onPaste ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid='canvas-menu-paste'
              onSelect={onPaste}
            >
              <Clipboard className='mr-2 h-4 w-4' aria-hidden='true' />
              {t('canvas.contextMenu.paste')}
              <DropdownMenuShortcut>
                {formatShortcut({ mod: true, key: 'V' })}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
