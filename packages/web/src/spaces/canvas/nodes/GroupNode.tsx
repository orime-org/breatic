// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { cn } from '@web/lib/utils';
import {
  MAX_NODE_NAME_LEN,
  useInlineRename,
} from '@web/spaces/canvas/nodes/_shared/use-inline-rename';
import type { GroupNodeView } from '@web/spaces/canvas/types/node-view';

/** Fixed-English default shown when a group has no explicit name. */
const GROUP_DEFAULT_NAME = 'Group';

interface GroupNodeProps {
  data: GroupNodeView;
  selected?: boolean;
  /**
   * Generic node prop carried by the registry. A group has **no lock**
   * (§1.1 — grouping is the organizational dimension; content editability is
   * each node's own lock), so this is intentionally ignored.
   */
  locked?: boolean;
  /** Commit a rename, pre-bound to this group's id by the ReactFlow wrapper. */
  onRename?: (name: string) => void;
}

/**
 * Group container node — a canvas region that holds other nodes (model
 * revision 2026-06-15: group is a core feature). A dashed, optionally tinted
 * container with a name label above it; double-click the name to rename
 * inline (Enter / blur commits, Escape cancels — the shared node-name editor).
 * Geometry is derived from the group's children at render (no manual resize);
 * members are independent nodes drawn on top, not re-rendered here.
 * @param root0 - Group node props.
 * @param root0.data - Group view (name + container tint + child ids).
 * @param root0.selected - Whether the group is selected, tinting its border.
 * @param root0.onRename - Called with the new name on a committed rename.
 * @returns The group container element.
 */
export function GroupNode({
  data,
  selected,
  onRename,
}: GroupNodeProps): React.JSX.Element {
  const display =
    data.name && data.name.length > 0 ? data.name : GROUP_DEFAULT_NAME;
  const { editing, draft, inputRef, startEdit, setDraft, commit, cancel } =
    useInlineRename({
      current: display,
      maxLength: MAX_NODE_NAME_LEN,
      onRename,
    });

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
      {editing ? (
        <input
          ref={inputRef}
          data-testid='group-name-input'
          value={draft}
          maxLength={MAX_NODE_NAME_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          // `nodrag` lets a pointer press select text instead of dragging the
          // group; the input only renders while editing, so it's always safe.
          className='nodrag absolute -top-5 left-0 max-w-[180px] rounded-content-xs border-0 bg-muted px-1 text-xs text-foreground outline-none [field-sizing:content]'
        />
      ) : (
        <div
          data-testid='group-name'
          onDoubleClick={startEdit}
          className='absolute -top-5 left-0 max-w-[180px] truncate text-xs text-muted-foreground'
        >
          {display}
        </div>
      )}
    </div>
  );
}
