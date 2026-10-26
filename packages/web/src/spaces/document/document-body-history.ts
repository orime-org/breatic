// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createExtension, type ExtensionFactoryInstance } from '@blocknote/core';
import { Plugin, PluginKey, type Command } from '@tiptap/pm/state';
import type * as Y from 'yjs';

import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { BodyAppliedBatch } from '@web/spaces/document/document-body-binding-types';
import { nameBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodySelectionName } from '@web/spaces/document/document-body-positions-types';
import type { DocumentUndoOptions } from '@web/spaces/document/document-undo-blocknote';

/** One original native item carries both semantic selection directions. */
interface HistorySelection {
  readonly pre: BodySelectionName;
  readonly post: BodySelectionName;
}

/** Only the public metadata owned by the project is read from native items. */
interface NativeHistoryItem {
  readonly meta: Map<unknown, unknown>;
}

/** The native stack event fields needed by this adapter. */
interface NativeHistoryEvent {
  readonly stackItem: NativeHistoryItem;
  readonly origin: unknown;
}

const SELECTION_META = Symbol('documentBodyHistorySelection');

/**
 * Adapts the existing editor command to the current handle's native stack.
 * @param manager - The original handle-owned manager.
 * @param options - The matching origin and runtime supplied by its handle.
 * @param direction - The public native history direction.
 * @returns A command with a final runtime, phase and permission check.
 * @throws {Error} If native undo or source projection fails.
 */
function nativeHistoryCommand(manager: Y.UndoManager, options: DocumentUndoOptions, direction: 'undo' | 'redo'): Command {
  return (state, dispatch): boolean => {
    const binding = bodyBindingOf(state);
    if (binding === null || binding.history !== manager || binding.origin !== options.origin || binding.runtime !== options.runtime || !binding.canWrite()) return false;
    const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
    if (stack.length === 0) return false;
    if (dispatch === undefined) return true;
    return manager[direction]() !== null;
  };
}

/**
 * Attaches selection metadata to the real native stack and final binding frame.
 * @param manager - The single original manager for the document handle.
 * @param options - The matching binding's approved user origin and runtime.
 * @returns The plugin owning only its history subscriptions.
 * @throws {Error} If mounting has no matching records binding.
 */
function historySelectionPlugin(manager: Y.UndoManager, options: DocumentUndoOptions): Plugin {
  return new Plugin({
    key: new PluginKey('documentBodyHistory'),
    view: (view) => {
      const binding = bodyBindingOf(view.state);
      if (binding === null || binding.history !== manager || binding.origin !== options.origin || binding.runtime !== options.runtime) throw new Error('Native body history requires its matching records binding');
      let acceptedItem: NativeHistoryItem | null = null;

      /**
       * Tracks capture updates and transfers original metadata to inverse items.
       * @param event - The actual native added or updated stack item.
       * @throws {never}
       */
      const onStackItem = (event: NativeHistoryEvent): void => {
        if (event.origin === options.origin) acceptedItem = event.stackItem;
        else if (event.origin === manager) {
          const selection: unknown = manager.currStackItem?.meta.get(SELECTION_META);
          if (selection !== undefined) event.stackItem.meta.set(SELECTION_META, selection);
        }
      };

      /**
       * Saves earliest root pre-selection and the final successful post-selection.
       * @param batch - The complete committed root and append batch.
       * @throws {Error} If its final native selection cannot be named.
       */
      const onApplied = (batch: BodyAppliedBatch): void => {
        if (batch.source !== 'user' || acceptedItem === null) return;
        const item = acceptedItem;
        acceptedItem = null;
        const prior = item.meta.get(SELECTION_META) as HistorySelection | undefined;
        item.meta.set(SELECTION_META, {
          pre: prior?.pre ?? batch.preSelection,
          post: nameBodySelection(batch.projection.index, batch.postSelection),
        } satisfies HistorySelection);
      };

      /**
       * Hands the current item's direction to the source projection before observers.
       * @param transaction - The native undo or redo transaction being cleaned up.
       * @throws {never}
       */
      const onBeforeObservers = (transaction: Y.Transaction): void => {
        if (transaction.origin !== manager) return;
        const selection = manager.currStackItem?.meta.get(SELECTION_META) as HistorySelection | undefined;
        if (selection !== undefined) binding.requestSelection(manager.undoing ? selection.pre : selection.post);
      };

      /**
       * Clears transient capture ownership after native history has published.
       * @throws {never}
       */
      const onPopped = (): void => { acceptedItem = null; };

      manager.on('stack-item-added', onStackItem);
      manager.on('stack-item-updated', onStackItem);
      manager.on('stack-item-popped', onPopped);
      binding.doc.on('beforeObserverCalls', onBeforeObservers);
      const stopApplied = binding.subscribeApplied(onApplied);

      return {
        destroy: (): void => {
          stopApplied();
          manager.off('stack-item-added', onStackItem);
          manager.off('stack-item-updated', onStackItem);
          manager.off('stack-item-popped', onPopped);
          binding.doc.off('beforeObserverCalls', onBeforeObservers);
          acceptedItem = null;
        },
      };
    },
  });
}

/**
 * Registers records history under the editor's existing undo extension key.
 * @param manager - The handle-owned native document manager.
 * @param options - The same handle's runtime and unique user origin.
 * @returns The existing editor undo/redo interface without XML sync plugins.
 * @throws {Error} If extension or history plugin construction fails.
 */
export function documentBodyHistoryExtension(manager: Y.UndoManager, options: DocumentUndoOptions): ExtensionFactoryInstance {
  return createExtension(() => ({
    key: 'yUndo',
    prosemirrorPlugins: [historySelectionPlugin(manager, options)],
    undoCommand: nativeHistoryCommand(manager, options, 'undo'),
    redoCommand: nativeHistoryCommand(manager, options, 'redo'),
  }) as never)();
}
