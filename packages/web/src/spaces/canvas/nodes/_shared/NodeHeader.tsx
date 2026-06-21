// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { cn } from '@web/lib/utils';
import {
  MODALITY_ICONS,
  MODALITY_LABEL,
} from '@web/spaces/canvas/nodes/_shared/modality';
import {
  MAX_NODE_NAME_LEN,
  useInlineRename,
} from '@web/spaces/canvas/nodes/_shared/use-inline-rename';
import type { Modality } from '@web/spaces/canvas/types/node-view';

interface NodeHeaderProps {
  modality: Modality;
  /** Current node name; blank falls back to the modality label. */
  name?: string;
  /** Selected — the name (and icon) deepen/brighten to mark the active node. */
  selected?: boolean;
  /** Viewer mode — the name is read-only. */
  readOnly?: boolean;
  /** Locked — the node is locked, so the name is frozen (no inline edit). */
  locked?: boolean;
  /** Commit a rename (Enter / blur with a non-blank value); omit for a display-only header. */
  onRename?: (name: string) => void;
}

/**
 * The node name header rendered above a content node's body: a fixed-size
 * row of the modality icon + the editable name. Double-click the name to
 * edit inline; Enter or blur commits a non-blank value, Escape cancels.
 * Pure presentational — the parent wires `onRename` to the Yjs write.
 * @param root0 - Node header props.
 * @param root0.modality - The node modality (selects the icon).
 * @param root0.name - The current node name (blank → modality label).
 * @param root0.selected - Whether the node is selected; deepens/brightens the name + icon.
 * @param root0.readOnly - Viewer mode; disables editing.
 * @param root0.locked - Whether the node is locked; freezes the name (no inline edit).
 * @param root0.onRename - Called with the new name on commit.
 * @returns The node name header element.
 */
export function NodeHeader({
  modality,
  name,
  selected = false,
  readOnly = false,
  locked = false,
  onRename,
}: NodeHeaderProps): React.JSX.Element {
  const Icon = MODALITY_ICONS[modality];
  const display = name && name.length > 0 ? name : MODALITY_LABEL[modality];
  const { editing, draft, inputRef, startEdit, setDraft, commit, cancel } =
    useInlineRename({
      current: display,
      readOnly,
      locked,
      maxLength: MAX_NODE_NAME_LEN,
      onRename,
    });

  return (
    <div
      data-testid='node-header'
      // Selected names deepen (light) / brighten (dark) to mark the active node;
      // the icon follows via `currentColor`. Unselected names dim to mid grey so
      // only the active one stands out — a cue that survives low zoom where the
      // selection border is thinned (canvas-nodes design §5.1).
      className={cn(
        'flex max-w-[16rem] items-center gap-1.5 px-1 text-xs',
        selected ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon className='h-4 w-4 shrink-0 opacity-70' aria-hidden='true' />
      {editing ? (
        <input
          ref={inputRef}
          data-testid='node-header-input'
          value={draft}
          maxLength={MAX_NODE_NAME_LEN}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          // Borderless edit field matching the project-title editor
          // (TitleEditable): no input chrome box, just a subtle muted fill;
          // width follows the content length (`field-sizing`) up to the cap.
          // `nodrag` lets a pointer press select text instead of dragging the
          // node (the input only renders while editing, so it's always safe).
          // `-ml-1` cancels the `px-1` left padding's offset so the text stays
          // at the same x as the static span — entering edit must not shift the
          // name sideways (the fill still gets its breathing room from px-1).
          className='nodrag -ml-1 min-w-[3rem] max-w-full rounded-content-xs border-0 bg-muted px-1 text-foreground outline-none [field-sizing:content]'
        />
      ) : (
        <span
          data-testid='node-header-name'
          onDoubleClick={startEdit}
          className='min-w-0 flex-1 truncate'
        >
          {display}
        </span>
      )}
    </div>
  );
}
