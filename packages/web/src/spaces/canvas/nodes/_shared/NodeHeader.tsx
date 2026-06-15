// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import {
  MODALITY_ICONS,
  MODALITY_LABEL,
} from '@web/spaces/canvas/nodes/_shared/modality';
import type { Modality } from '@web/spaces/canvas/types/node-view';

interface NodeHeaderProps {
  modality: Modality;
  /** Current node name; blank falls back to the modality label. */
  name?: string;
  /** Viewer mode — the name is read-only. */
  readOnly?: boolean;
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
 * @param root0.readOnly - Viewer mode; disables editing.
 * @param root0.onRename - Called with the new name on commit.
 * @returns The node name header element.
 */
export function NodeHeader({
  modality,
  name,
  readOnly = false,
  onRename,
}: NodeHeaderProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // Guards Enter + blur from double-firing the commit (and stops a stale
  // blur from committing after Escape) — a ref so the check is synchronous.
  const editingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const Icon = MODALITY_ICONS[modality];
  const display = name && name.length > 0 ? name : MODALITY_LABEL[modality];

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  /**
   * Enter edit mode (unless read-only), seeding the draft with the display name.
   */
  const startEdit = (): void => {
    if (readOnly) return;
    setDraft(display);
    editingRef.current = true;
    setEditing(true);
  };

  /**
   * Commit the trimmed draft as the new name and leave edit mode. Blank
   * drafts leave the name unchanged. Guarded so Enter + the unmount blur
   * fire at most one rename.
   */
  const commit = (): void => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const next = draft.trim();
    if (next.length > 0) onRename?.(next);
    setEditing(false);
  };

  /**
   * Leave edit mode discarding the draft (Escape).
   */
  const cancel = (): void => {
    editingRef.current = false;
    setEditing(false);
  };

  return (
    <div
      data-testid='node-header'
      className='flex items-center gap-1.5 px-1 pb-1 text-xs text-foreground'
    >
      <Icon className='h-4 w-4 shrink-0 opacity-70' aria-hidden='true' />
      {editing ? (
        <input
          ref={inputRef}
          data-testid='node-header-input'
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
          }}
          className='min-w-0 flex-1 rounded-sm border border-border bg-background px-1 outline-none'
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
