// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@web/lib/utils';
import {
  groupBackgroundStyle,
  groupBorderStyle,
} from '@web/spaces/canvas/group-background';
import {
  MAX_NODE_NAME_LEN,
  useInlineRename,
} from '@web/spaces/canvas/nodes/_shared/use-inline-rename';
import { ZoomCounterScaled } from '@web/spaces/canvas/nodes/_shared/ZoomCounterScaled';
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
 * The group owns its authoritative size (stored width/height, user-resizable via
 * the GroupResizer; group redesign 2026-06-23) and fills the ReactFlow wrapper;
 * members are independent nodes drawn on top, not re-rendered here.
 * @param root0 - Group node props.
 * @param root0.data - Group view (name + container tint + child ids).
 * @param root0.selected - Whether the group is selected, tinting its border.
 * @param root0.onRename - Called with the new name on a committed rename.
 * @returns The group container element.
 */
export const GroupNode = React.memo(function GroupNode({
  data,
  selected,
  onRename,
}: GroupNodeProps): React.JSX.Element {
  const display =
    data.name && data.name.length > 0 ? data.name : GROUP_DEFAULT_NAME;
  const background = groupBackgroundStyle(data.backgroundColor);
  // A tinted group carries its hue on the dashed border too (#1549
  // calibration: dark-mode tints alone are hard to tell apart). The color
  // travels through a local CSS variable + a static arbitrary class rather
  // than an inline `border-color` (a shorthand jsdom's cssstyle drops when
  // fed var(), and a class keeps the selected state on the normal cascade).
  const borderToken = selected
    ? undefined
    : groupBorderStyle(data.backgroundColor);
  const {
    editing,
    displayName,
    draft,
    inputRef,
    startEdit,
    setDraft,
    commit,
    cancel,
  } = useInlineRename({
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
      style={
        background || borderToken
          ? ({
            ...(background ? { backgroundColor: background } : {}),
            ...(borderToken ? { '--group-tint-border': borderToken } : {}),
          } as React.CSSProperties)
          : undefined
      }
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
          : borderToken
            ? 'border-[color:var(--group-tint-border)]'
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
      <ZoomCounterScaled className='absolute bottom-full left-0 origin-bottom-left pb-1'>
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
              else if (e.key === 'Escape') {
                // Mark the key consumed: window-level Esc consumers (the
                // focus-session exit, the crop overlay staging) yield on
                // `defaultPrevented` — the same protocol every other Esc
                // consumer follows (SpaceTab / TitleEditable, round-12).
                e.preventDefault();
                cancel();
              }
            }}
            // `nodrag` lets a pointer press select text instead of dragging the
            // group; the input only renders while editing, so it's always safe.
            // `-ml-1` cancels the `px-1` left padding so entering edit doesn't
            // shift the name sideways — the fill still gets its breathing room
            // from `px-1`. `min-w-[3rem]` keeps a usable edit target for a very
            // short / empty name. Both match NodeHeader (the node-name rename).
            className='nodrag -ml-1 block min-w-[3rem] max-w-[180px] rounded-content-xs border-0 bg-muted px-1 text-xs text-foreground outline-none [field-sizing:content]'
          />
        ) : (
          <div
            data-testid='group-name'
            onDoubleClick={startEdit}
            // Selected groups deepen/brighten their name (same rule as node
            // names, canvas-nodes design §5.1) so the active group reads at a
            // glance when its dashed border is zoom-thinned.
            className={cn(
              'block max-w-[180px] truncate text-xs',
              selected ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {displayName}
          </div>
        )}
      </ZoomCounterScaled>
    </div>
  );
});
