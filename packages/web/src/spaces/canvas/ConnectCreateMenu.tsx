// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { connectableCreatableTypes } from '@web/spaces/canvas/lib/connect-create';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';

interface ConnectCreateMenuProps {
  /** Whether the menu is open (driven by the canvas's connect-end handler). */
  open: boolean;
  /** Viewport x of the wire release, the menu anchors here. */
  x: number;
  /** Viewport y of the wire release, the menu anchors here. */
  y: number;
  /** The dragged source node's modality — filters the offered rows. */
  sourceKind: string;
  /** Open-state change (Escape / outside click closes it). */
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen creatable node type. */
  onPick: (type: CreatableNodeType) => void;
}

/**
 * The drag-to-blank "create + connect" menu (batch-2 item 3): releasing a
 * wire dragged from an output stub over blank canvas anchors this menu at the
 * release point. Same zero-size-anchor controlled `DropdownMenu` technique as
 * `CanvasContextMenu` (Radix menus cannot otherwise anchor to an arbitrary
 * point), and the same shared rows — filtered to the creatable types whose
 * input accepts the dragged source, so a picked row can never be rejected at
 * the edge write.
 * @param root0 - Component props.
 * @param root0.open - Whether the menu is open.
 * @param root0.x - Viewport x to anchor the menu at.
 * @param root0.y - Viewport y to anchor the menu at.
 * @param root0.sourceKind - The dragged source node's modality.
 * @param root0.onOpenChange - Open-state change callback.
 * @param root0.onPick - Called with the chosen creatable node type.
 * @returns The release-point-anchored create + connect menu.
 */
export const ConnectCreateMenu = React.memo(function ConnectCreateMenu({
  open,
  x,
  y,
  sourceKind,
  onOpenChange,
  onPick,
}: ConnectCreateMenuProps): React.JSX.Element {
  const types = React.useMemo(
    () => connectableCreatableTypes(sourceKind),
    [sourceKind],
  );
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden='true'
          data-testid='connect-create-anchor'
          style={{ position: 'fixed', left: x, top: y, height: 0, width: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start'>
        <CreatableNodeMenuItems onPick={onPick} types={types} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
