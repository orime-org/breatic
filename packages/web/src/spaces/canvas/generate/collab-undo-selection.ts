// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Fixes undo/redo SELECTION restore for the collaborative prompt editor.
 *
 * Root cause (upstream timing bug, traced 2026-07-14): y-prosemirror /
 * `@tiptap/y-tiptap` store the pre-edit selection in each undo stack item's meta
 * (`stack-item-added`) and hand it to the sync binding on `stack-item-popped`
 * so the restore transaction re-applies it. But yjs (>= 13.6.x) emits
 * `stack-item-popped` AFTER `popStackItem`'s transact returns — by then the
 * sync binding's observer has ALREADY built + dispatched the restore
 * transaction using the `beforeAllTransactions` snapshot (the selection at
 * undo time), and `afterAllTransactions` has reset it. Result: after Cmd+Z the
 * caret sits where it was at undo time (before the restored content) instead
 * of where it was before the edit, and a range deletion never restores its
 * selection. Worse, the too-late `stack-item-popped` write LINGERS in
 * `binding.beforeTransactionSelection`, so the NEXT remote change would restore
 * a stale selection.
 *
 * Fix, using public Yjs API only:
 * - `doc.on('beforeObserverCalls')` fires INSIDE the transaction cleanup,
 *   BEFORE type observers build the restore transaction. For an undo/redo
 *   transaction (origin === this editor's UndoManager) the popped item is
 *   available as `undoManager.currStackItem` (set during the transact, cleared
 *   after the late emit) — hand its stored selection to the binding THERE.
 * - After the late `stack-item-popped` emit re-writes the stale value, clear it
 *   in a microtask so the next unrelated transaction snapshots fresh.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';

import {
  Y_SYNC_PLUGIN_KEY_NAME,
  Y_UNDO_PLUGIN_KEY_NAME,
} from '@web/spaces/canvas/generate/collab-plugin-keys';

/** The sync binding's fields this fix touches (structural, library-internal shape). */
interface SyncBinding {
  /** The relative selection consumed by the next Yjs→PM restore transaction. */
  beforeTransactionSelection: unknown;
  /** The bound Y.Doc (used to subscribe transaction-lifecycle events). */
  doc: {
    on: (event: string, handler: (transaction: YTransactionLike) => void) => void;
    off: (event: string, handler: (transaction: YTransactionLike) => void) => void;
  };
}

/** The Yjs UndoManager fields this fix reads (structural). */
interface UndoManagerLike {
  /** The stack item being popped; set during the undo/redo transact. */
  currStackItem: { meta: Map<unknown, unknown> } | null;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
}

/** The Yjs transaction fields this fix reads (structural). */
interface YTransactionLike {
  origin: unknown;
}

/**
 * Resolves the y-sync binding and y-undo manager from the editor state by
 * plugin key name (y-prosemirror is a transitive dependency, so the plugin
 * keys are located by their stable key names instead of imports).
 * @param state - The editor state.
 * @returns The binding + undo manager, or null when collaboration is absent.
 */
function collabInternals(
  state: EditorState,
): { binding: SyncBinding; undoManager: UndoManagerLike } | null {
  /**
   * Finds a state plugin by its stable key name.
   * @param name - The plugin key name (e.g. 'y-sync$').
   * @returns The plugin, or undefined.
   */
  const byKey = (name: string): Plugin | undefined =>
    state.plugins.find((pl) => (pl as unknown as { key?: string }).key === name);
  const sync = byKey(Y_SYNC_PLUGIN_KEY_NAME)?.getState(state) as
    | { binding?: SyncBinding }
    | undefined;
  const undo = byKey(Y_UNDO_PLUGIN_KEY_NAME)?.getState(state) as
    | { undoManager?: UndoManagerLike }
    | undefined;
  return sync?.binding && undo?.undoManager
    ? { binding: sync.binding, undoManager: undo.undoManager }
    : null;
}

/**
 * TipTap extension installing the undo/redo selection-restore fix. Added AFTER
 * Collaboration in the extension list; no-ops when collaboration is absent.
 */
/** Key for this extension's own plugin state (the unpolluted pre-edit selection). */
const collabUndoSelectionKey = new PluginKey<{ preEditSel: unknown }>(
  'collabUndoSelectionRestore',
);

export const CollabUndoSelection = Extension.create({
  name: 'collabUndoSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: collabUndoSelectionKey,
        state: {
          init: (): { preEditSel: unknown } => ({ preEditSel: null }),
          /**
           * Tracks the UNPOLLUTED pre-edit selection. The y-undo plugin's
           * `prevSel` is overwritten by EVERY transaction — including our own
           * appendTransaction follow-ups (whitespace invariant / selection
           * normalization), which replace "selection before the user's edit"
           * with "selection after it" whenever a dispatch carries appended
           * transactions (an upstream blind spot: the library assumes one
           * dispatch = one user transaction). Here we copy the library's
           * freshly-computed relative selection ONLY on a NON-appended
           * doc-changing transaction, so appended follow-ups cannot pollute it.
           * @param tr - The transaction being applied.
           * @param val - The previous plugin state.
           * @param _oldState - The state before the transaction.
           * @param newState - The state after (y-undo's field already updated).
           * @returns The next plugin state.
           */
          apply: (tr, val, _oldState, newState): { preEditSel: unknown } => {
            if (!tr.docChanged || tr.getMeta('appendedTransaction') !== undefined) {
              return val;
            }
            const undo = newState.plugins
              .find(
                (pl) =>
                  (pl as unknown as { key?: string }).key ===
                  Y_UNDO_PLUGIN_KEY_NAME,
              )
              ?.getState(newState) as { prevSel?: unknown } | undefined;
            return undo?.prevSel != null ? { preEditSel: undo.prevSel } : val;
          },
        },
        view: (view) => {
          const internals = collabInternals(view.state);
          if (!internals) {
            // This extension is only installed alongside Collaboration, so a
            // failed lookup means the y-sync/y-undo plugin keys were not found
            // — most likely a SECOND @tiptap/y-tiptap copy entered the bundle
            // (pnpm mints per-peer-set instances; the second copy's keys mint
            // as 'y-sync$1'). Without this warning the whole undo selection
            // restore would silently no-op. Dev-only; stripped from prod.
            if (import.meta.env.DEV) {
              console.warn(
                '[collab-undo-selection] y-sync/y-undo plugin state not found — ' +
                  'undo selection restore is INACTIVE. Is a duplicate ' +
                  '@tiptap/y-tiptap copy in the bundle?',
              );
            }
            return {};
          }
          const { binding, undoManager } = internals;
          /**
           * Hands the popped stack item's stored selection to the binding
           * BEFORE the sync observer builds the restore transaction.
           * @param transaction - The Yjs transaction being cleaned up.
           */
          const onBeforeObserverCalls = (transaction: YTransactionLike): void => {
            if (transaction.origin !== undoManager) return;
            const stored = undoManager.currStackItem?.meta.get(binding);
            if (stored != null) binding.beforeTransactionSelection = stored;
          };
          /**
           * Clears the stale selection the upstream late `stack-item-popped`
           * write leaves behind (a microtask runs after that synchronous emit
           * regardless of listener order), so the next unrelated transaction
           * snapshots a fresh selection.
           */
          const onPopped = (): void => {
            queueMicrotask(() => {
              binding.beforeTransactionSelection = null;
            });
          };
          /**
           * Overwrites the freshly-added stack item's stored selection with the
           * UNPOLLUTED pre-edit selection (see the plugin state above). This
           * handler registers after the library's (extension order), so it runs
           * after the polluted write and wins.
           * @param payload - The undo-manager event payload.
           * @param payload.stackItem - The stack item just pushed.
           * @param payload.stackItem.meta - The item's per-binding meta map.
           */
          const onAdded = ({
            stackItem,
          }: {
            stackItem: { meta: Map<unknown, unknown> };
          }): void => {
            const preEditSel = collabUndoSelectionKey.getState(view.state)?.preEditSel;
            if (preEditSel != null) stackItem.meta.set(binding, preEditSel);
          };
          binding.doc.on('beforeObserverCalls', onBeforeObserverCalls);
          undoManager.on('stack-item-popped', onPopped);
          undoManager.on('stack-item-added', onAdded as never);
          return {
            destroy: (): void => {
              binding.doc.off('beforeObserverCalls', onBeforeObserverCalls);
              undoManager.off('stack-item-popped', onPopped);
              undoManager.off('stack-item-added', onAdded as never);
            },
          };
        },
      }),
    ];
  },
});
