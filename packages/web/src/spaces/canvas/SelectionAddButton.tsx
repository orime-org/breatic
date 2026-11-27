// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { MessageSquarePlus, Plus } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { connectableCreatableTypesForAny } from '@web/spaces/canvas/lib/connect-create';
import { CREATABLE_NODE_TYPES, type CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';
import { SELECTION_ADD_BUTTON_PX } from '@web/spaces/canvas/selection-add';

/** The plus's size; the preview wires end at its left edge. */
const BUTTON_SIZE: React.CSSProperties = { width: SELECTION_ADD_BUTTON_PX, height: SELECTION_ADD_BUTTON_PX };

interface SelectionAddButtonProps {
  /** The modalities of the nodes a pick would wire in. */
  sourceKinds: readonly string[];
  /** Whether the menu is open. */
  open: boolean;
  /** Open-state change (the plus, Escape, an outside press). */
  onOpenChange: (open: boolean) => void;
  /** Called with the picked node type. */
  onPick: (type: CreatableNodeType) => void;
  /** Hands the selection to the Agent. */
  onAddToAgent: () => void;
  /** Holds Add to Agent still while the chat changes conversation. */
  addToAgentDisabled: boolean;
}

/**
 * The plus beside a multi-selection or a selected group (inner#2216) and its
 * menu: the four creatable types, greyed out where no selected node
 * connects into them, then Add to Agent. It sits in a `NodeToolbar`, so the
 * menu follows the canvas viewport like every overlay anchored on the canvas.
 * @param root0 - Component props.
 * @param root0.sourceKinds - The modalities of the nodes a pick wires in.
 * @param root0.open - Whether the menu is open.
 * @param root0.onOpenChange - Open-state change.
 * @param root0.onPick - Called with the picked node type.
 * @param root0.onAddToAgent - Hands the selection to the Agent.
 * @param root0.addToAgentDisabled - Holds Add to Agent still.
 * @returns The plus and its menu.
 */
export const SelectionAddButton = React.memo(function SelectionAddButton({
  sourceKinds,
  open,
  onOpenChange,
  onPick,
  onAddToAgent,
  addToAgentDisabled,
}: SelectionAddButtonProps): React.JSX.Element {
  const t = useTranslation();
  useFollowCanvasViewport(open);
  const disabledTypes = React.useMemo(() => {
    const offered = new Set(connectableCreatableTypesForAny(sourceKinds));
    return CREATABLE_NODE_TYPES.filter((type) => !offered.has(type));
  }, [sourceKinds]);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={null}
          size={null}
          type='button'
          data-testid='selection-add-button'
          className='flex select-none items-center justify-center rounded-full border border-border bg-popover text-foreground hover-enabled:bg-accent'
          style={BUTTON_SIZE}
        >
          <Plus className='size-4' aria-hidden='true' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side='right' align='start' avoidCollisions={false}>
        <CreatableNodeMenuItems onPick={onPick} disabledTypes={disabledTypes} />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid='selection-add-to-agent'
          disabled={addToAgentDisabled}
          onSelect={onAddToAgent}
        >
          <MessageSquarePlus className='mr-2 h-4 w-4' aria-hidden='true' />
          {t('canvas.contextMenu.addToAgent')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
