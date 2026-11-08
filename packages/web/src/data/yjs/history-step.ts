// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the next undo or redo writes to a Space document (inner#1790), for
 * every Yjs undo manager a Space uses (canvas, the document body, the TipTap
 * editors, timeline, 3D).
 *
 * Below the limit nothing is judged: every kind runs there. Once the Space is
 * full the step is run by yjs itself on a throwaway copy of the document, and
 * what it wrote there is judged with shared `updateShape`, the same reading
 * collab applies to the real update. Predicting it from the stack entry would
 * have to reproduce `popStackItem` and `redoItem` (skipped entries, redone
 * chains, map keys overwritten since), which is what the copy avoids.
 */

import * as Y from 'yjs';
import { updateShape } from '@breatic/shared';

import { readDocSize } from '@web/data/yjs/doc-size';
import { docNameOf } from '@web/data/yjs/manager';
import type { SpaceWriteKind } from '@web/data/yjs/space-write';

/** One entry of an undo or redo stack. */
type StackItem = Y.UndoManager['undoStack'][number];

/** What the next undo or redo writes, as `writeSpaceDoc` takes it. */
export interface HistoryStep {
  kind: SpaceWriteKind;
  /**
   * The step writes nothing. Its kind is `remove`, which every state but
   * `resyncing` lets through, so the entry still calls `undo()`/`redo()` and
   * yjs pops the entries that change nothing, as it would anyway.
   */
  noEffect: boolean;
}

/** A step that brings content back, and one that cannot be tried (the strictest kind). */
const ADD: HistoryStep = { kind: 'add', noEffect: false };
const NO_EFFECT: HistoryStep = { kind: 'remove', noEffect: true };

/**
 * The copy's counterpart of one type in the manager's scope.
 * @param type - A scope entry of the real manager.
 * @param real - The real document.
 * @param copy - The copy loaded from it.
 * @returns The copy's type, `deleted` when the real type has been deleted, or null when it cannot be found.
 * @throws {Error} When the copy's store lacks the type's item.
 */
function copyScopeType(type: Y.AbstractType<unknown> | Y.Doc, real: Y.Doc, copy: Y.Doc): Y.AbstractType<unknown> | 'deleted' | null {
  if (!(type instanceof Y.AbstractType)) return null;
  const item = type._item;
  if (item === null) {
    for (const [key, root] of real.share) {
      if (root === type) return copy.get(key, type.constructor as new () => Y.AbstractType<unknown>);
    }
    return null;
  }
  if (type.doc !== real) return null;
  if (item.deleted) return 'deleted';
  const copied = Y.getItem(copy.store, item.id);
  return copied.content instanceof Y.ContentType ? copied.content.type : null;
}

/**
 * `redone` is runtime state of the real items and is not encoded. Give the
 * copy the same pointers, split to the same boundaries, so its undo follows
 * the same redo chains.
 * @param real - The real document.
 * @param copy - The copy.
 * @throws {Error} When the copy's store lacks an item.
 */
function copyRedone(real: Y.Doc, copy: Y.Doc): void {
  copy.transact((tr) => {
    real.store.clients.forEach((structs) => {
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.redone === null) continue;
        const item = Y.getItemCleanStart(tr, struct.id);
        if (item.length > struct.length) {
          Y.getItemCleanEnd(tr, copy.store, Y.createID(struct.id.client, struct.id.clock + struct.length - 1));
        }
        item.redone = struct.redone;
      }
    });
  });
}

/**
 * A stack entry for the copy's manager, so popping it leaves the real one alone.
 * @param entry - The real entry.
 * @returns The copy.
 */
function copyEntry(entry: StackItem): StackItem {
  return { insertions: entry.insertions, deletions: entry.deletions, meta: new Map() };
}

/**
 * Runs the step on a copy of the document and judges what it wrote.
 * @param manager - The real undo manager.
 * @param direction - Which stack runs.
 * @returns The step.
 * @throws {Error} Whatever yjs or the manager's delete filter throws on the copy.
 */
function trial(manager: Y.UndoManager, direction: 'undo' | 'redo'): HistoryStep {
  const real = manager.doc;
  const copy = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(real));
    const scope: Array<Y.AbstractType<unknown>> = [];
    for (const type of manager.scope) {
      const found = copyScopeType(type, real, copy);
      if (found === 'deleted') return NO_EFFECT;
      if (found === null) return ADD;
      scope.push(found);
    }
    copyRedone(real, copy);
    const copyManager = new Y.UndoManager(scope, {
      deleteFilter: manager.deleteFilter,
      ignoreRemoteMapChanges: manager.ignoreRemoteMapChanges,
      captureTimeout: 0,
    });
    copyManager.undoStack = manager.undoStack.map(copyEntry);
    copyManager.redoStack = manager.redoStack.map(copyEntry);
    const updates: Uint8Array[] = [];
    copy.on('update', (update: Uint8Array) => { updates.push(update); });
    copyManager[direction]();
    copyManager.destroy();
    if (updates.length === 0) return NO_EFFECT;
    // The real store has not changed: it is the store before the step.
    const shape = updateShape(Y.mergeUpdates(updates), real.store);
    if (!shape.pureDelete) return ADD;
    return { kind: shape.wholeTypesOnly ? 'remove' : 'delete', noEffect: false };
  } finally {
    copy.destroy();
  }
}

/**
 * What the next undo or redo writes, for `writeSpaceDoc` (design 5.2): every
 * entry runs `writeSpaceDoc(name, nextHistoryStep(manager, direction), () =>
 * manager[direction]())`. Below the limit (and while the size is unknown) the
 * step is not judged; while resyncing `writeSpaceDoc` refuses it whatever the
 * kind; full or over the ceiling, it is run on a copy first.
 * @param manager - The undo manager about to run.
 * @param direction - Which stack runs.
 * @returns Its kind, and whether it writes nothing; `add` when the trial cannot be run.
 * @throws {never} A trial that throws is judged `add`.
 */
export function nextHistoryStep(manager: Y.UndoManager, direction: 'undo' | 'redo'): HistoryStep {
  const name = docNameOf(manager.doc);
  if (name === null || readDocSize(name).phase !== 'full') return ADD;
  try {
    return trial(manager, direction);
  } catch {
    // A step that cannot be tried is not let through a full Space.
    return ADD;
  }
}
