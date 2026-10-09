// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Undo restores the SELECTION, not only the text.
 *
 * Without this, undoing a deletion brings the words back and leaves the caret
 * wherever it was when the key was pressed, so the user has to find the
 * restored text themselves. y-prosemirror means to do better and cannot, for
 * two reasons that are independent of each other.
 *
 * ## The stored selection arrives too late
 *
 * The undo plugin puts the pre-edit selection on the stack item and hands it to
 * the sync binding on `stack-item-popped` (`y-prosemirror.cjs:2174-2179`), and
 * the binding replays it while building the restore transaction
 * (`:708`). But yjs emits that event AFTER `popStackItem`'s transact returns
 * (`yjs.cjs:3574` sits outside the `transact` closing at `:3571`), and the
 * binding's observer has already run and dispatched by then — it is called from
 * inside the transaction cleanup. The handover lands one step late every time,
 * which is why the caret sits at the undo-time position instead.
 *
 * The public event that fires at the right moment is `beforeObserverCalls`
 * (`yjs.cjs:3292`), inside the cleanup and ahead of the observers. The popped
 * item is reachable there as `undoManager.currStackItem`, which yjs sets during
 * the transact (`:3562`) and clears only after the late emit (`:3576`).
 *
 *
 * ## The stored selection is the wrong one
 *
 * `prevSel` is recomputed on EVERY transaction from the state before it
 * (`y-prosemirror.cjs:2151`), and the stack item is written from whatever it
 * holds once the dispatch is over. One user edit is not always one transaction:
 * a block-creating edit lands two, because a new block needs an id and
 * BlockNote's `uniqueID` plugin stamps one from an `appendTransaction`
 * (`blocks-CzQLehlc.js:168-169`). Measured on an Enter: two doc-changing
 * transactions in one dispatch, so `prevSel` ends up holding the caret from
 * BETWEEN them — after the split rather than before it. Splitting blocks is
 * ordinary typing here, not an edge case.
 *
 * So the pre-edit selection is tracked here instead, off the first
 * doc-changing, non-appended transaction of each dispatch, and written over the
 * stack item afterwards.
 *
 * ## Two things `collab-undo-selection.ts` does that this does not
 *
 * That file is the same fix for the editors still on `@tiptap/y-tiptap`, and
 * copying it over wholesale would bring two pieces neither of which holds here.
 *
 * It strips `absAnchor` / `absHead` off the stored selection, because y-tiptap
 * 3.0.6 records absolute positions alongside the relative ones and uses them to
 * "correct" an endpoint — which misfires on a selection replayed across time.
 * y-prosemirror records no such fields; `absAnchor` appears nowhere in its dist.
 *
 * It also clears `binding.beforeTransactionSelection` in a microtask after the
 * late emit, on the grounds that the value outlives the change it belonged to
 * and the next remote change would replay it. The value does linger — measured,
 * non-null after an undo settles, null with the clear in place. What could not
 * be measured is any consequence: it is the selection the undo has just put the
 * caret at, so replaying it lands the caret where it already is, and a single
 * selection-only dispatch clears it before a remote change can arrive. No
 * mutation of this file turns a test red for the want of it, so it is not here.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey, yUndoPluginKey } from 'y-prosemirror';

import { syncBindingOf } from '@web/spaces/document/document-link-tracking';
import { undoRedo } from '@web/spaces/document/document-yjs-origin';

/** The bound Yjs document, carrying the transaction-lifecycle events. */
interface YDocLike {
  on(event: 'beforeObserverCalls', handler: (transaction: YTransactionLike) => void): void;
  off(event: 'beforeObserverCalls', handler: (transaction: YTransactionLike) => void): void;
}

/** The sync binding fields this fix touches. */
interface SyncBinding {
  /** The relative selection the next Yjs→PM restore transaction consumes. */
  beforeTransactionSelection: unknown;
  /** The bound document. */
  doc: YDocLike;
}

/** What `stack-item-added` hands its listeners. */
interface StackItemEvent {
  /** The item just pushed. */
  readonly stackItem: { readonly meta: Map<unknown, unknown> };
}

/** The undo manager fields this fix reads. */
export interface UndoManagerLike {
  /** The item being popped, set for the duration of the undo transact. */
  readonly currStackItem: { readonly meta: Map<unknown, unknown> } | null;
  on(event: 'stack-item-added', handler: (event: StackItemEvent) => void): void;
  off(event: 'stack-item-added', handler: (event: StackItemEvent) => void): void;
}

/** The Yjs transaction field this fix reads. */
interface YTransactionLike {
  /** Whatever passed the change along; the manager itself on undo and redo. */
  origin: unknown;
}

/**
 * Keeps a value on every undo stack item and hands it back when that item is
 * undone or redone — on `beforeObserverCalls`, ahead of the observer that turns
 * the change into a ProseMirror transaction, for the reason given at the top of
 * this file.
 * @param doc - The bound Yjs document.
 * @param undoManager - The undo manager.
 * @param key - The key the value is kept under on each item's meta.
 * @param capture - Gives the value for an item just pushed, or null to keep none.
 * @param restore - Takes the value kept on the item being undone or redone, or
 *   undefined when it has none; called on every undo and redo transaction.
 * @returns A function that stops keeping and handing back.
 */
export function keepOnUndoStack(
  doc: YDocLike,
  undoManager: UndoManagerLike,
  key: unknown,
  capture: () => unknown,
  restore: (stored: unknown) => void,
): () => void {
  /**
   * Keeps the captured value on the item just pushed.
   * @param event - The event payload.
   * @param event.stackItem - The item just pushed.
   */
  const onAdded = ({ stackItem }: StackItemEvent): void => {
    const value = capture();
    if (value != null) stackItem.meta.set(key, value);
  };
  /**
   * Hands back the value kept on the item being undone or redone.
   * @param transaction - The Yjs transaction being cleaned up.
   */
  const onBeforeObserverCalls = (transaction: YTransactionLike): void => {
    if (transaction.origin !== undoManager) return;
    restore(undoManager.currStackItem?.meta.get(key));
  };
  undoManager.on('stack-item-added', onAdded);
  doc.on('beforeObserverCalls', onBeforeObserverCalls);
  return (): void => {
    undoManager.off('stack-item-added', onAdded);
    doc.off('beforeObserverCalls', onBeforeObserverCalls);
  };
}

/** A plugin's Yjs names, kept on each undo stack item and handed back on its undo or redo. */
export interface NamesOnUndoStack<T> {
  /**
   * The names as they stood before the edit an undo or redo takes back.
   * @param tr - The transaction being applied.
   * @returns Those names on the reader's undo or redo of an edit that kept
   *   some; null for every other transaction.
   */
  readonly handedFor: (tr: Transaction) => T | null;
  /**
   * Starts keeping names for a view's undo stack.
   * @param view - The editor view.
   * @returns The function that stops it.
   */
  readonly attach: (view: EditorView) => () => void;
}

/**
 * Keeps a plugin's Yjs names for what it tracks on every undo stack item, the
 * way y-prosemirror's undo plugin keeps the selection: the names are taken
 * when a Yjs transaction begins (`beforeAllTransactions`), which is before the
 * plugin's view retakes them against the edited body, and the item that edit
 * pushes keeps them.
 * @param current - The names in this state, or null to keep none.
 * @returns The handover for the plugin's state and its view.
 */
export function namesOnUndoStack<T>(current: (state: EditorState) => T | null): NamesOnUndoStack<T> {
  let before: T | null = null;
  let handed: T | null = null;
  return {
    handedFor: (tr) => (undoRedo(tr) ? handed : null),
    attach: (view) => {
      const doc = syncBindingOf(view.state)?.doc;
      const undo = (
        yUndoPluginKey.getState(view.state) as { undoManager?: UndoManagerLike } | undefined
      )?.undoManager;
      if (doc === undefined || undo === undefined) return () => undefined;
      const stopKeeping = keepOnUndoStack(doc, undo, {}, () => before, (stored) => {
        handed = (stored as T | undefined) ?? null;
      });
      /** Takes the names as they stand before a Yjs transaction. */
      const onBeforeAll = (): void => {
        before = current(view.state);
      };
      doc.on('beforeAllTransactions', onBeforeAll);
      return () => {
        stopKeeping();
        doc.off('beforeAllTransactions', onBeforeAll);
      };
    },
  };
}

/** This plugin's own state: the pre-edit selection, kept clean. */
interface PreEditState {
  /** The relative selection from before the user's edit, or null. */
  preEditSel: unknown;
}

const key = new PluginKey<PreEditState>('documentUndoSelection');

/**
 * The plugin that restores the selection on undo and redo.
 *
 * Registered AFTER `yUndoPlugin` in the same array, which is what puts its
 * `stack-item-added` handler behind the upstream one so that the value written
 * here is the one that survives.
 * @returns The ProseMirror plugin.
 */
export function documentUndoSelectionPlugin(): Plugin<PreEditState> {
  return new Plugin<PreEditState>({
    key,

    state: {
      /**
       * Starts with nothing recorded.
       * @returns The initial state.
       */
      init: (): PreEditState => ({ preEditSel: null }),

      /**
       * Copies the undo plugin's freshly computed selection, but only off the
       * transaction that carries the user's own edit — the appended follow-ups
       * of the same dispatch would replace "before the edit" with "after it".
       * @param tr - The transaction being applied.
       * @param value - The previous state.
       * @param _oldState - The state before the transaction.
       * @param newState - The state after it, the undo plugin already updated.
       * @returns The next state.
       */
      apply: (tr, value, _oldState, newState): PreEditState => {
        if (!tr.docChanged || tr.getMeta('appendedTransaction') !== undefined) {
          return value;
        }
        const undo = yUndoPluginKey.getState(newState) as
          | { prevSel?: unknown }
          | undefined;
        return undo?.prevSel != null ? { preEditSel: undo.prevSel } : value;
      },
    },

    /**
     * Subscribes the two handlers for as long as the editor lives.
     * @param view - The editor view.
     * @returns The plugin view, whose destroy unsubscribes them.
     */
    view: (view) => {
      const binding = (
        ySyncPluginKey.getState(view.state) as { binding?: SyncBinding }
      )?.binding;
      const undoManager = (
        yUndoPluginKey.getState(view.state) as {
          undoManager?: UndoManagerLike;
        }
      )?.undoManager;
      if (!binding || !undoManager) {
        return {};
      }

      // Keyed by the binding, which is where upstream keeps the selection, so
      // this overwrites what it stored.
      const stop = keepOnUndoStack(
        binding.doc,
        undoManager,
        binding,
        () => key.getState(view.state)?.preEditSel ?? null,
        (stored) => {
          if (stored != null) binding.beforeTransactionSelection = stored;
        },
      );
      return { destroy: stop };
    },
  });
}
