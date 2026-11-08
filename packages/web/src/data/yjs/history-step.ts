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
import { writeSpaceDoc, type SpaceWriteKind, type SpaceWriteResult } from '@web/data/yjs/space-write';

/** One entry of an undo or redo stack. */
type StackItem = Y.UndoManager['undoStack'][number];

/** A manager's last trial and what it was judged on. */
interface Verdict {
  top: StackItem;
  undo: number;
  redo: number;
  updates: number;
  kind: SpaceWriteKind;
}

/**
 * The kind of a step that writes nothing: every state but `resyncing` lets it
 * through, so the entry still calls `undo()`/`redo()` and yjs pops the entries
 * that change nothing, as it would anyway.
 */
const NO_EFFECT: SpaceWriteKind = 'remove';

/** Each manager's last trial, so holding undo on a refused step copies the document once. */
const verdicts = new WeakMap<Y.UndoManager, Verdict>();
/** How many updates each judged document has had since its first trial. */
const updateCounts = new WeakMap<Y.Doc, { count: number }>();

/**
 * The update counter of a document, started on first use.
 * @param doc - The real document.
 * @returns Its counter.
 * @throws {never} Never.
 */
function updateCounter(doc: Y.Doc): { count: number } {
  let counter = updateCounts.get(doc);
  if (counter === undefined) {
    const created = { count: 0 };
    doc.on('update', () => { created.count += 1; });
    updateCounts.set(doc, created);
    counter = created;
  }
  return counter;
}

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
 * @returns Its kind.
 * @throws {Error} Whatever yjs or the manager's delete filter throws on the copy.
 */
function trial(manager: Y.UndoManager, direction: 'undo' | 'redo'): SpaceWriteKind {
  const real = manager.doc;
  const copy = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(real));
    const scope: Array<Y.AbstractType<unknown>> = [];
    for (const type of manager.scope) {
      const found = copyScopeType(type, real, copy);
      if (found === 'deleted') return NO_EFFECT;
      if (found === null) return 'add';
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
    if (!shape.pureDelete) return 'add';
    return shape.wholeTypesOnly ? 'remove' : 'delete';
  } finally {
    copy.destroy();
  }
}

/**
 * What the next undo or redo writes, for `writeSpaceDoc` (design 5.2). Below
 * the limit (and while the size is unknown) the step is not judged; while
 * resyncing `writeSpaceDoc` refuses it whatever the kind; full or over the
 * ceiling, it is run on a copy first, unless that stack is empty or the
 * manager's last trial still holds (same top entry, stack lengths and
 * document updates).
 * @param manager - The undo manager about to run.
 * @param direction - Which stack runs.
 * @returns Its kind: `remove` for a step that writes nothing, `add` when the trial cannot be run.
 * @throws {never} A trial that throws is judged `add`.
 */
export function nextHistoryStep(manager: Y.UndoManager, direction: 'undo' | 'redo'): SpaceWriteKind {
  const name = docNameOf(manager.doc);
  if (name === null || readDocSize(name).phase !== 'full') return 'add';
  const top = manager[direction === 'undo' ? 'undoStack' : 'redoStack'].at(-1);
  if (top === undefined) return NO_EFFECT;
  const updates = updateCounter(manager.doc).count;
  const undo = manager.undoStack.length;
  const redo = manager.redoStack.length;
  const last = verdicts.get(manager);
  if (last !== undefined && last.top === top && last.undo === undo && last.redo === redo && last.updates === updates) return last.kind;
  let kind: SpaceWriteKind;
  try {
    kind = trial(manager, direction);
  } catch {
    // A step that cannot be tried is not let through a full Space.
    kind = 'add';
  }
  verdicts.set(manager, { top, undo, redo, updates, kind });
  return kind;
}

/**
 * Runs an undo or redo the way every entry does: judged by `nextHistoryStep`,
 * then through `writeSpaceDoc`, which shows the toast and leaves the stacks
 * alone when it refuses.
 * @param name - Canonical document name.
 * @param manager - The undo manager.
 * @param direction - Which stack runs.
 * @returns What `writeSpaceDoc` answered.
 * @throws {Error} Whatever the step itself throws.
 */
export function runHistoryStep(name: string, manager: Y.UndoManager, direction: 'undo' | 'redo'): SpaceWriteResult {
  return writeSpaceDoc(name, { kind: nextHistoryStep(manager, direction) }, () => { manager[direction](); });
}
