// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Mirrors the undo manager's availability into React state for the toolbar.
 *
 * **Two reasons this does not read the editor's transaction stream.**
 *
 * Undo pushes onto the redo stack AFTER the document change is dispatched, so a
 * subscriber woken by that transaction reads the redo stack as it was a moment
 * earlier — still empty — and never hears the correction. Measured: after
 * `undo()` exactly one transaction fires and redo is already available once
 * things settle, yet a transaction-driven reader has latched `false`.
 *
 * **And two reasons the stack events alone are not enough either.** yjs drains
 * "dead" stack items — ones whose content a collaborator has since deleted —
 * without emitting anything: `popStackItem` discards them, and since undoing a
 * remotely-deleted edit changes nothing, no `stack-item-popped` is reported. An
 * events-only mirror then goes stale and leaves a button lit that does nothing
 * when clicked. So callers must {@link DocumentHistoryState.sync} right after
 * running undo or redo. The canvas hit this same pair of traps and settled on
 * the same shape.
 */

import * as React from 'react';
import type { UndoManager } from 'yjs';

/** What the history buttons need, plus the re-read they must trigger. */
export interface DocumentHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Re-read both stacks from the manager. **Must** be called immediately after
   * running undo or redo — see the module doc for why the events miss that case.
   */
  sync: () => void;
}

/** The stack events the manager does announce; each changes availability. */
const STACK_EVENTS = [
  'stack-item-added',
  'stack-item-popped',
  'stack-cleared',
] as const;

/**
 * Track whether undo and redo are currently available.
 * @param undoManager - The document's undo manager, or null before it exists.
 * @returns Current availability plus the imperative re-read.
 */
export function useDocumentHistory(
  undoManager: UndoManager | null,
): DocumentHistoryState {
  const [state, setState] = React.useState({ canUndo: false, canRedo: false });

  const sync = React.useCallback((): void => {
    setState({
      canUndo: undoManager ? undoManager.canUndo() : false,
      canRedo: undoManager ? undoManager.canRedo() : false,
    });
  }, [undoManager]);

  React.useEffect(() => {
    if (!undoManager) {
      setState({ canUndo: false, canRedo: false });
      return undefined;
    }
    STACK_EVENTS.forEach((event) => undoManager.on(event, sync));
    // Seed from the current stacks — the manager outlives the component, so it
    // may already carry history from before this mount.
    sync();
    return (): void => {
      STACK_EVENTS.forEach((event) => undoManager.off(event, sync));
    };
  }, [undoManager, sync]);

  return { canUndo: state.canUndo, canRedo: state.canRedo, sync };
}
