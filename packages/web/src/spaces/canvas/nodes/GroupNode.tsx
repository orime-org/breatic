// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';
import type { GroupNodeView } from '@web/spaces/canvas/types/node-view';

interface GroupNodeProps {
  data: GroupNodeView;
  selected?: boolean;
  locked?: boolean;
}

/**
 * Group container node — a canvas region that holds other nodes (model
 * revision 2026-06-15: group is a core feature). This is the minimal
 * placeholder: a dashed, optionally tinted container so the group renders
 * cleanly. The full grouping interactions (marquee-group, lock-move, child
 * containment via ReactFlow `parentId`) land in the dedicated group slice.
 * @param root0 - Group node props.
 * @param root0.data - Group view (container tint + child ids).
 * @param root0.selected - Whether the group is selected, tinting its border.
 * @param root0.locked - Whether the group is locked, showing the lock indicator.
 * @returns The group container element.
 */
export function GroupNode({
  data,
  selected,
  locked,
}: GroupNodeProps): React.JSX.Element {
  return (
    <div
      data-testid='group-node'
      data-selected={selected ? 'true' : 'false'}
      data-locked={locked ? 'true' : 'false'}
      style={
        data.backgroundColor
          ? { backgroundColor: data.backgroundColor }
          : undefined
      }
      className={cn(
        'relative min-h-[80px] min-w-[160px] rounded-lg border border-dashed transition-colors',
        selected ? 'border-status-selected' : 'border-border',
      )}
    >
      {locked ? (
        <div
          aria-hidden='true'
          data-testid='node-lock-indicator'
          className='absolute right-1 top-1 rounded-full bg-muted px-1 text-2xs text-muted-foreground'
        >
          lock
        </div>
      ) : null}
    </div>
  );
}
