// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { useInlineEditExit } from '@web/lib/inline-edit-exit';
import { useHeldName } from '@web/lib/use-held-name';
import { whenBlurLeaves } from '@web/lib/blur-left';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { flowNodeWrapper } from '@web/spaces/canvas/flow-node-wrapper';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { useCanvasStore } from '@web/stores';

/** The inline-rename controller returned by {@link useInlineRename}. */
export interface InlineRename {
  /** Whether the inline editor is currently open. */
  editing: boolean;
  /**
   * The name to render when not editing — the just-committed value during the
   * async gap before the Yjs write round-trips back into `current`, else
   * `current`. Render this (not the raw `current`) so closing the editor never
   * flashes the stale old name (R2-G).
   */
  displayName: string;
  /** The in-progress draft value bound to the editor input. */
  draft: string;
  /** Ref to attach to the editor input — it is focused + selected on open. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Open the editor, seeding the draft with the current display value. */
  startEdit: () => void;
  /** Update the draft as the user types. */
  setDraft: (value: string) => void;
  /**
   * The editor input's blur handler: commits when the reader leaves the input,
   * and not when its Space is hidden or the browser loses focus.
   */
  blur: () => void;
  /**
   * The editor input's keydown: Enter commits the trimmed, clipped draft
   * (blank leaves the name unchanged), Escape discards it, and either gives the
   * keyboard back to the node's wrapper.
   */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** The editor input's compositionend. */
  onCompositionEnd: () => void;
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
 * commits a trimmed non-blank value, Escape cancels, and a key that ends the
 * edit gives the keyboard back to the node's ReactFlow wrapper. Owning the
 * editing / draft state + the double-fire guard here keeps the one rule in one
 * place; each consumer renders its own input + label markup around it.
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
  // The Yjs write reaches `current` through an observe, a render later than
  // the editor closes (R2-G).
  const { shown: displayName, hold } = useHeldName(current);
  // Guards Enter + blur from double-firing the commit (and stops a stale
  // blur from committing after Escape) — a ref so the check is synchronous.
  const editingRef = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // On entering edit, focus AND select the whole name so a keystroke
  // replaces it immediately (matches the project-title editor). Once only: a
  // Space shown again runs this effect again, and the reader is mid-word.
  const selectedOnEntry = React.useRef(false);
  React.useEffect(() => {
    if (!editing) {
      selectedOnEntry.current = false;
      return;
    }
    if (selectedOnEntry.current) return;
    selectedOnEntry.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEdit = React.useCallback((): void => {
    if (readOnly || locked) return;
    setDraft(displayName);
    editingRef.current = true;
    setEditing(true);
  }, [readOnly, locked, displayName]);

  const commit = React.useCallback((): void => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const next = draft.trim().slice(0, maxLength);
    if (next.length > 0) {
      onRename?.(next);
      hold(next);
    }
    setEditing(false);
  }, [draft, maxLength, onRename, hold]);

  const { spaceId } = useCanvasContext();
  const blur = React.useCallback((): void => {
    whenBlurLeaves(spaceId, commit);
  }, [spaceId, commit]);

  const cancel = React.useCallback((): void => {
    editingRef.current = false;
    setEditing(false);
  }, []);

  const nodeId = React.useContext(NodeIdContext);
  const exit = useInlineEditExit({
    editing,
    target: () => (nodeId == null ? null : flowNodeWrapper(spaceId, nodeId)),
    commit,
    cancel,
  });

  // External rename trigger: the right-click menu's "Rename" lives at the canvas
  // level and can't reach this node's edit state directly, so it posts this
  // node's id to the store's `pendingRename` mailbox. The matching node picks it
  // up here, enters edit (no-op if locked / read-only — `startEdit` guards), and
  // clears the mailbox either way so it never gets stuck. The id comes from the
  // wrapper-provided NodeIdContext (null outside the canvas → the watch no-ops).
  const isRenameTarget = useCanvasStore(
    (s) => nodeId != null && s.pendingRename === nodeId,
  );
  const consumePendingRename = useCanvasStore((s) => s.consumePendingRename);
  React.useEffect(() => {
    if (!isRenameTarget) return;
    startEdit();
    consumePendingRename();
  }, [isRenameTarget, startEdit, consumePendingRename]);

  return {
    editing,
    displayName,
    draft,
    inputRef,
    startEdit,
    setDraft,
    blur,
    onKeyDown: exit.onKeyDown,
    onCompositionEnd: exit.onCompositionEnd,
  };
}
