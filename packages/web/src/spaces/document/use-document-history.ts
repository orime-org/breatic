// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Mirrors undo / redo availability into React state for the toolbar.
 *
 * Two traps here, both of which produce a button that lies about what it will
 * do, and neither of which the editor's transaction stream can see:
 *
 * - Undo fills the redo stack AFTER dispatching its document change, so
 *   anything sampling during that transaction reads a stale empty stack and
 *   never hears the correction.
 * - yjs discards stack entries whose content a collaborator has since deleted
 *   WITHOUT announcing it — undoing such an entry changes nothing, so no event
 *   fires and no transaction is dispatched either.
 *
 * The second one is why this hook listens for the ACTION as well as the stack
 * events: the manager reports every undo and redo, effect or not, so a drained
 * stack is always noticed. That reporting lives on the manager rather than at
 * each call site because the keyboard shortcuts go straight to the command and
 * never touch React — a "remember to re-read" contract had already been broken
 * there once.
 */

import * as React from 'react';

import type { DocumentUndoManager } from '@web/spaces/document/document-undo';

/** What the history buttons need to know. */
export interface DocumentHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

const NOTHING_AVAILABLE: DocumentHistoryState = {
  canUndo: false,
  canRedo: false,
};

/** The stack events the manager announces on its own. */
const STACK_EVENTS = [
  'stack-item-added',
  'stack-item-popped',
  'stack-cleared',
] as const;

/**
 * Track whether undo and redo are currently available.
 * @param undoManager - The document's undo manager, or null before it exists.
 * @returns Current availability.
 */
export function useDocumentHistory(
  undoManager: DocumentUndoManager | null,
): DocumentHistoryState {
  const [state, setState] = React.useState<DocumentHistoryState>(
    NOTHING_AVAILABLE,
  );

  React.useEffect(() => {
    if (!undoManager) {
      setState(NOTHING_AVAILABLE);
      return undefined;
    }
    /** Re-reads both stacks, keeping the old object when nothing moved. */
    const sync = (): void => {
      const canUndo = undoManager.canUndo();
      const canRedo = undoManager.canRedo();
      setState((prev) =>
        prev.canUndo === canUndo && prev.canRedo === canRedo
          ? prev
          : { canUndo, canRedo },
      );
    };

    STACK_EVENTS.forEach((event) => undoManager.on(event, sync));
    const stopWatchingActions = undoManager.onAfterHistoryAction(sync);
    // Seed from the current stacks — the manager outlives the component, so it
    // may already carry history from before this mount.
    sync();

    return (): void => {
      STACK_EVENTS.forEach((event) => undoManager.off(event, sync));
      stopWatchingActions();
    };
  }, [undoManager]);

  return state;
}
