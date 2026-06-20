// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@web/lib/utils';
import { groupBackgroundStyle } from '@web/spaces/canvas/group-background';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';
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
   * Generic node prop carried by the registry — the same value as `data.locked`
   * for a group. The group reads `data.locked` directly (lock indicator + name
   * freeze), so this duplicate prop is unused here.
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
  const background = groupBackgroundStyle(data.backgroundColor);
  // Counter-scale the name with the canvas zoom so it keeps a constant screen
  // size — the same treatment node names get (ContentNodeFrame).
  const headerScale = React.useContext(NodeScaleContext);
  const { editing, draft, inputRef, startEdit, setDraft, commit, cancel } =
    useInlineRename({
      current: display,
      // A locked group's name is frozen with its structure (decision 2026-06-20).
      locked: data.locked,
      maxLength: MAX_NODE_NAME_LEN,
      onRename,
    });

  return (
    <div
      data-testid='group-node'
      data-selected={selected ? 'true' : 'false'}
      style={background ? { backgroundColor: background } : undefined}
      className={cn(
        // Fill the ReactFlow wrapper (sized to the derived rect) so the tint
        // + border cover the whole group, not just the min box. The border
        // reuses the node shell's treatment (NodeShell): node radius + the
        // same 3-state colours, kept dashed to read as a container — the group
        // does not invent its own border line / radius. ReactFlow's built-in
        // `.react-flow__node-group` border / background / padding is suppressed
        // in index.css so only this renders.
        'relative size-full min-h-[80px] min-w-[160px] rounded-sm border border-dashed transition-colors',
        selected
          ? 'border-status-selected'
          : 'border-border hover:border-foreground-disabled',
      )}
    >
      {/* A locked group shows a lock badge so the frozen structure reads at a
          glance (the group-lock menu toggles it). */}
      {data.locked ? (
        <div
          aria-hidden='true'
          data-testid='group-lock-indicator'
          className='absolute right-1 top-1 rounded-full bg-muted p-0.5 text-muted-foreground'
        >
          <Lock className='h-3 w-3' />
        </div>
      ) : null}
      {/* Name floats above the group's top-left, counter-scaled by zoom so it
          stays a constant screen size — mirrors the node name header. */}
      <div
        className='absolute bottom-full left-0 origin-bottom-left pb-1'
        style={{ transform: `scale(${headerScale})` }}
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
            className='nodrag block max-w-[180px] rounded-content-xs border-0 bg-muted px-1 text-xs text-foreground outline-none [field-sizing:content]'
          />
        ) : (
          <div
            data-testid='group-name'
            onDoubleClick={startEdit}
            className='block max-w-[180px] truncate text-xs text-muted-foreground'
          >
            {display}
          </div>
        )}
      </div>
    </div>
  );
}
