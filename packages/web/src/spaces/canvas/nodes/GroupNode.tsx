// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';
import type { GroupNodeView } from '@web/spaces/canvas/types/node-view';

interface GroupNodeProps {
  data: GroupNodeView;
  selected?: boolean;
  /**
   * Generic node prop carried by the registry. A group has **no lock**
   * (§1.1 — grouping is the organizational dimension; content editability is
   * each node's own lock), so this is intentionally ignored.
   */
  locked?: boolean;
}

/**
 * Group container node — a canvas region that holds other nodes (model
 * revision 2026-06-15: group is a core feature). A dashed, optionally tinted
 * container with a name label above it. Geometry is derived from the group's
 * children at render (no manual resize); members are independent nodes drawn
 * on top, not re-rendered here.
 * @param root0 - Group node props.
 * @param root0.data - Group view (name + container tint + child ids).
 * @param root0.selected - Whether the group is selected, tinting its border.
 * @returns The group container element.
 */
export function GroupNode({
  data,
  selected,
}: GroupNodeProps): React.JSX.Element {
  return (
    <div
      data-testid='group-node'
      data-selected={selected ? 'true' : 'false'}
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
      <div
        data-testid='group-name'
        className='absolute -top-5 left-0 max-w-[180px] truncate text-xs text-muted-foreground'
      >
        {data.name ?? 'Group'}
      </div>
    </div>
  );
}
