// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/** Node name length cap — over-long names are clipped on commit + ellipsised. */
export const MAX_NODE_NAME_LEN = 30;

/** The inline-rename controller returned by {@link useInlineRename}. */
export interface InlineRename {
  /** Whether the inline editor is currently open. */
  editing: boolean;
  /** The in-progress draft value bound to the editor input. */
  draft: string;
  /** Ref to attach to the editor input — it is focused + selected on open. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Open the editor, seeding the draft with the current display value. */
  startEdit: () => void;
  /** Update the draft as the user types. */
  setDraft: (value: string) => void;
  /** Commit the trimmed/clipped draft (Enter / blur); blank leaves it unchanged. */
  commit: () => void;
  /** Discard the draft and close the editor (Escape). */
  cancel: () => void;
}

/** {@link useInlineRename} inputs. */
interface UseInlineRenameOptions {
  /** Display value seeded into the draft when editing starts. */
  current: string;
  /** Viewer mode — editing is disabled (`startEdit` becomes a no-op). */
  readOnly?: boolean;
  /** Locked — the object's name is frozen, so editing is disabled (`startEdit` no-ops). */
  locked?: boolean;
  /** Name length cap applied (with a trim) on commit. */
  maxLength: number;
  /** Called with the committed, non-blank name. */
  onRename?: (name: string) => void;
}

/**
 * The shared inline name-edit state machine behind the canvas node name
 * header and the group name label: double-click to edit, Enter / blur
 * commits a trimmed non-blank value, Escape cancels. Owning the editing /
 * draft state + the double-fire guard here keeps the one rule in one place;
 * each consumer renders its own input + label markup around it.
 * @param root0 - The current value, length cap, read-only / locked flags, and commit callback.
 * @param root0.current - Display value seeded into the draft when editing starts.
 * @param root0.readOnly - Viewer mode — editing is disabled (`startEdit` no-ops).
 * @param root0.locked - Locked — the name is frozen, so editing is disabled (`startEdit` no-ops).
 * @param root0.maxLength - Name length cap applied (with a trim) on commit.
 * @param root0.onRename - Called with the committed, non-blank name.
 * @returns The inline-rename controller (state + handlers + input ref).
 */
export function useInlineRename({
  current,
  readOnly = false,
  locked = false,
  maxLength,
  onRename,
}: UseInlineRenameOptions): InlineRename {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // Guards Enter + blur from double-firing the commit (and stops a stale
  // blur from committing after Escape) — a ref so the check is synchronous.
  const editingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // On entering edit, focus AND select the whole name so a keystroke
  // replaces it immediately (matches the project-title editor).
  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = React.useCallback((): void => {
    if (readOnly || locked) return;
    setDraft(current);
    editingRef.current = true;
    setEditing(true);
  }, [readOnly, locked, current]);

  const commit = React.useCallback((): void => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const next = draft.trim().slice(0, maxLength);
    if (next.length > 0) onRename?.(next);
    setEditing(false);
  }, [draft, maxLength, onRename]);

  const cancel = React.useCallback((): void => {
    editingRef.current = false;
    setEditing(false);
  }, []);

  return { editing, draft, inputRef, startEdit, setDraft, commit, cancel };
}
