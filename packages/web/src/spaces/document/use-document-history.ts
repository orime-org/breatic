// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tracks whether undo / redo are currently available, for the toolbar buttons.
 *
 * **Why this is not read off the editor's transaction stream.** The obvious
 * approach — subscribing to editor transactions and asking `can().undo()` — is
 * measurably wrong for redo. Undo pushes onto the redo stack AFTER the document
 * change has been dispatched, so a subscriber woken by that transaction reads
 * the redo stack as it was a moment earlier (still empty) and never hears about
 * the correction. Probed: after `undo()` exactly one transaction fires, and
 * `can().redo()` is already true once things settle — yet a transaction-driven
 * reader has by then latched `false`. The button would sit dead until some
 * unrelated edit happened to wake it.
 *
 * So availability is taken from the source instead: the Yjs undo manager
 * announces its own stack changes, and those fire after the stacks are correct.
 */

import type { Editor } from '@tiptap/react';
import * as React from 'react';
import type { UndoManager } from 'yjs';

import { Y_UNDO_PLUGIN_KEY_NAME } from '@web/spaces/canvas/generate/collab-plugin-keys';

/** What the history buttons need to know. */
export interface DocumentHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

const NOTHING_AVAILABLE: DocumentHistoryState = {
  canUndo: false,
  canRedo: false,
};

/** The stack events the undo manager announces; all three change availability. */
const STACK_EVENTS = [
  'stack-item-added',
  'stack-item-popped',
  'stack-cleared',
] as const;

/**
 * Locate the collaborative undo manager on an editor.
 *
 * Found by plugin-key NAME rather than by importing the key object, for the
 * reason documented on {@link Y_UNDO_PLUGIN_KEY_NAME} — and with the same
 * limitation: a duplicate copy of the binding in the bundle would mint a
 * different name and this returns null, leaving the buttons permanently
 * disabled rather than silently wrong.
 * @param editor - The editor to inspect, or null before it mounts.
 * @returns The undo manager, or null when collaboration is not active.
 */
function undoManagerOf(editor: Editor | null): UndoManager | null {
  if (!editor || editor.isDestroyed) return null;
  const plugin = editor.state.plugins.find(
    (p) => (p as unknown as { key?: string }).key === Y_UNDO_PLUGIN_KEY_NAME,
  );
  if (!plugin) return null;
  const state = plugin.getState(editor.state) as
    | { undoManager?: UndoManager }
    | undefined;
  return state?.undoManager ?? null;
}

/**
 * Read the live availability of undo and redo.
 * @param editor - The document editor, or null before it mounts.
 * @returns Whether each direction is currently available.
 */
export function useDocumentHistory(
  editor: Editor | null,
): DocumentHistoryState {
  const [state, setState] = React.useState<DocumentHistoryState>(
    NOTHING_AVAILABLE,
  );

  React.useEffect(() => {
    const manager = undoManagerOf(editor);
    if (!manager) {
      setState(NOTHING_AVAILABLE);
      return undefined;
    }

    /** Re-reads both stack depths straight from the manager. */
    const sync = (): void => {
      setState({
        canUndo: manager.undoStack.length > 0,
        canRedo: manager.redoStack.length > 0,
      });
    };

    STACK_EVENTS.forEach((event) => manager.on(event, sync));
    // Seed from the current stacks: the editor may already carry history when
    // this mounts (a re-render, or a hook mounted after some editing).
    sync();

    return (): void => {
      STACK_EVENTS.forEach((event) => manager.off(event, sync));
    };
  }, [editor]);

  return state;
}
