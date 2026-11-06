// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the next undo or redo does to a Space document's size (inner#1790),
 * for every Yjs undo manager a Space uses (canvas, the document body, the
 * TipTap editors).
 *
 * `Y.UndoManager` pops stack items until one changes something
 * (`UndoManager.js` `popStackItem`), so the item judged is the first from the
 * top that does: one with a live insertion to remove, or a deleted struct it
 * can bring back. Whether a struct comes back follows yjs `redoItem`: its
 * parent must be live or come back with it, and a map value must not have
 * been replaced by anyone else since. A step that brings nothing back is a
 * `delete`; one that only brings back values of keys that still hold one is
 * an `overwrite`; anything else is an `add`, estimated from the content it
 * brings back.
 */

import * as Y from 'yjs';

import { utf8Bytes, type SpaceWriteKind } from '@web/data/yjs/space-write';

/** Bytes counted for each struct an undo writes, over its own content. */
const ITEM_BYTES = 64;

/** One entry of an undo or redo stack. */
type StackItem = Y.UndoManager['undoStack'][number];

/** What the next undo or redo does to the size. */
export interface HistoryStep {
  kind: SpaceWriteKind;
  /** Bytes the structs it brings back can add. */
  estimate: number;
}

/**
 * Every struct a delete set covers, as the store holds it now.
 * @param store - The document's store.
 * @param ds - The delete set.
 * @returns The structs.
 */
function structsIn(store: Y.Doc['store'], ds: StackItem['deletions']): Array<Y.Item | Y.GC> {
  const out: Array<Y.Item | Y.GC> = [];
  for (const [client, ranges] of ds.clients) {
    const structs = store.clients.get(client);
    if (structs === undefined) continue;
    const state = Y.getState(store, client);
    for (const { clock, len } of ranges) {
      if (clock >= state) continue;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + len; i += 1) {
        out.push(structs[i]!);
      }
    }
  }
  return out;
}

/**
 * The struct an item was last redone as.
 * @param store - The document's store.
 * @param item - The item.
 * @returns The newest copy, or the item itself.
 */
function latest(store: Y.Doc['store'], item: Y.Item): Y.Item {
  let current = item;
  while (current.redone !== null) {
    const next = Y.getItem(store, current.redone);
    if (!(next instanceof Y.Item)) break;
    current = next;
  }
  return current;
}

/**
 * Whether the undo manager's scope holds a struct.
 * @param manager - The undo manager.
 * @param item - The struct.
 * @returns True when it is in scope.
 */
function inScope(manager: Y.UndoManager, item: Y.Item): boolean {
  return manager.scope.some((type) => type === manager.doc || (type instanceof Y.AbstractType && Y.isParentOf(type, item)));
}

/**
 * Whether a stack holds a deletion of an id.
 * @param stack - Stack items.
 * @param id - The id.
 * @returns True when one of them deleted it.
 */
function deletedByStack(stack: readonly StackItem[], id: Y.ID): boolean {
  return stack.some((s) => Y.isDeleted(s.deletions, id));
}

/** What `redoItem` reads besides the item. */
interface RedoContext {
  manager: Y.UndoManager;
  redoItems: Set<Y.Item>;
  insertions: StackItem['insertions'];
  undoStack: readonly StackItem[];
  redoStack: readonly StackItem[];
}

/**
 * Whether yjs `redoItem` brings a deleted item back rather than returning null.
 * @param item - The item.
 * @param ctx - The stack item being popped and the stacks around it.
 * @returns True when it comes back (or was brought back before).
 */
function comesBack(item: Y.Item, ctx: RedoContext): boolean {
  if (item.redone !== null) return true;
  const store = ctx.manager.doc.store;
  const parentItem = (item.parent as Y.AbstractType<unknown>)._item;
  if (parentItem !== null && parentItem.deleted && parentItem.redone === null
    && (!ctx.redoItems.has(parentItem) || !comesBack(parentItem, ctx))) return false;
  if (item.parentSub !== null && item.right !== null && !ctx.manager.ignoreRemoteMapChanges) {
    let left: Y.Item | null = item;
    while (left !== null && left.right !== null && (left.right.redone !== null || Y.isDeleted(ctx.insertions, left.right.id)
      || deletedByStack(ctx.undoStack, left.right.id) || deletedByStack(ctx.redoStack, left.right.id))) {
      left = latest(store, left.right);
    }
    if (left !== null && left.right !== null) return false;
  }
  return true;
}

/**
 * UTF-8 bytes of what an item holds.
 * @param item - The item.
 * @returns Bytes, with the per-struct overhead.
 */
function itemBytes(item: Y.Item): number {
  const { content } = item;
  const text = content instanceof Y.ContentString ? content.str : JSON.stringify(content.getContent()) ?? '';
  return utf8Bytes(text) + ITEM_BYTES;
}

/**
 * Judge a restored item: a map value whose key still holds one is an overwrite.
 * @param item - The item brought back.
 * @returns Its kind.
 */
function restoredKind(item: Y.Item): SpaceWriteKind {
  const parent = item.parent as Y.AbstractType<unknown>;
  if (item.parentSub === null || parent._item?.deleted === true) return 'add';
  const current = parent._map.get(item.parentSub);
  return current === undefined || current.deleted ? 'add' : 'overwrite';
}

/**
 * Judge one stack item as yjs would pop it.
 * @param manager - The undo manager.
 * @param stackItem - The item.
 * @param undoStack - The undo stack while it is popped.
 * @param redoStack - The redo stack while it is popped.
 * @returns What it does, or null when it changes nothing and yjs pops the next.
 */
function judgeItem(manager: Y.UndoManager, stackItem: StackItem, undoStack: readonly StackItem[], redoStack: readonly StackItem[]): HistoryStep | null {
  const store = manager.doc.store;
  const removes = structsIn(store, stackItem.insertions).some((s) => {
    if (!(s instanceof Y.Item)) return false;
    const item = latest(store, s);
    return !item.deleted && inScope(manager, item) && manager.deleteFilter(item);
  });
  const redoItems = new Set<Y.Item>();
  for (const s of structsIn(store, stackItem.deletions)) {
    if (s instanceof Y.Item && inScope(manager, s) && !Y.isDeleted(stackItem.insertions, s.id)) redoItems.add(s);
  }
  const ctx: RedoContext = { manager, redoItems, insertions: stackItem.insertions, undoStack, redoStack };
  const back = [...redoItems].filter((item) => comesBack(item, ctx));
  if (!removes && back.length === 0) return null;
  let kind: SpaceWriteKind = 'delete';
  let estimate = 0;
  for (const item of back) {
    // One brought back before is reused, not written again.
    if (item.redone !== null) continue;
    estimate += itemBytes(item);
    if (restoredKind(item) === 'add') kind = 'add';
    else if (kind === 'delete') kind = 'overwrite';
  }
  return { kind, estimate };
}

/**
 * What the next undo or redo does to the size.
 * @param manager - The undo manager about to run.
 * @param direction - Which stack runs.
 * @returns Its kind and estimate; a delete with nothing to add when no item changes anything.
 */
export function nextHistoryStep(manager: Y.UndoManager, direction: 'undo' | 'redo'): HistoryStep {
  const stack = direction === 'undo' ? manager.undoStack : manager.redoStack;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const rest = stack.slice(0, i);
    const step = direction === 'undo'
      ? judgeItem(manager, stack[i]!, rest, manager.redoStack)
      : judgeItem(manager, stack[i]!, manager.undoStack, rest);
    if (step !== null) return step;
  }
  return { kind: 'delete', estimate: 0 };
}
