// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import type { CanvasNodeFields } from '@breatic/shared';

import {
  getCanvasUndoManager,
  evictCanvasUndoManager,
  evictUndoForVanishedSpaces,
  _resetCanvasUndoCacheForTests,
  CANVAS_UNDO,
  addNode,
} from '@web/data/yjs/canvas-space';
import {
  getDoc,
  destroyDoc,
  docName,
  _resetForTests,
} from '@web/data/yjs/manager';

function makeNode(id: string): CanvasNodeFields {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      name: `node-${id}`,
      createdAt: 0,
      createdBy: 'tester',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
}

describe('canvas undo manager cache — lifecycle bound to the space doc, not the component', () => {
  beforeEach(() => {
    _resetCanvasUndoCacheForTests();
    _resetForTests();
  });

  it('invariant 1 — same doc returns the same cached manager (switch away + back preserves the stack)', () => {
    const p = 'proj-a';
    const s = 'space-a';
    const name = docName.canvasSpace(p, s);
    const doc = getDoc(name);

    const m1 = getCanvasUndoManager(doc, name);
    const m2 = getCanvasUndoManager(doc, name);
    expect(m2).toBe(m1); // same instance, not a fresh one

    // A tracked edit lands on the cached manager's stack.
    addNode(p, s, makeNode('A'));
    expect(m1.canUndo()).toBe(true);

    // Simulate "switch to another tab and back": re-fetch the manager for the
    // same doc. It must be the SAME instance with the stack still populated —
    // this is the whole point (the old bug destroyed it on remount).
    const m3 = getCanvasUndoManager(doc, name);
    expect(m3).toBe(m1);
    expect(m3.canUndo()).toBe(true);
  });

  it('invariant 2 — evict clears the stack (close tab → fresh empty history on reopen)', () => {
    const p = 'proj-b';
    const s = 'space-b';
    const name = docName.canvasSpace(p, s);
    const doc = getDoc(name);

    const m1 = getCanvasUndoManager(doc, name);
    addNode(p, s, makeNode('B'));
    expect(m1.canUndo()).toBe(true);

    // Closing the tab evicts the manager.
    evictCanvasUndoManager(name);

    // The doc itself is unaffected (still cached, instant reopen), but a NEW
    // manager for the same doc starts with an EMPTY stack — the node added
    // before it existed is not on its undo stack. Reopening = clean history.
    const doc2 = getDoc(name);
    expect(doc2).toBe(doc); // doc cache untouched by undo eviction
    const m2 = getCanvasUndoManager(doc2, name);
    expect(m2).not.toBe(m1);
    expect(m2.canUndo()).toBe(false);
  });

  it('invariant 3 — two space docs have independent managers', () => {
    const nameA = docName.canvasSpace('proj-c', 'space-x');
    const nameB = docName.canvasSpace('proj-c', 'space-y');
    const docA = getDoc(nameA);
    const docB = getDoc(nameB);
    const mA = getCanvasUndoManager(docA, nameA);
    const mB = getCanvasUndoManager(docB, nameB);
    expect(mA).not.toBe(mB);

    addNode('proj-c', 'space-x', makeNode('only-A'));
    expect(mA.canUndo()).toBe(true);
    expect(mB.canUndo()).toBe(false); // B's stack untouched by A's edit
  });

  it('invariant 4 — remote (non-CANVAS_UNDO) origin writes do not enter the local stack', () => {
    const name = docName.canvasSpace('proj-d', 'space-d');
    const doc = getDoc(name);
    const manager = getCanvasUndoManager(doc, name);

    // A collaborator's write carries a different origin and must be excluded.
    const nodesMap = doc.getMap<unknown>('nodesMap');
    doc.transact(() => nodesMap.set('remote-node', 1), 'remote');
    expect(manager.canUndo()).toBe(false);

    // Sanity: a local CANVAS_UNDO write IS tracked.
    doc.transact(() => nodesMap.set('local-flag', 1), CANVAS_UNDO);
    expect(manager.canUndo()).toBe(true);
  });

  it('invariant 6 — a doc recreated under the same name heals the stale cached manager', () => {
    // Defensive: today `destroyDoc` is never called, but if a future caller
    // destroys + recreates a space doc WITHOUT evicting the undo cache, the
    // cached manager would be bound to a dead doc. `getCanvasUndoManager` must
    // detect the mismatch and rebind to the live doc.
    const name = docName.canvasSpace('proj-f', 'space-f');
    const doc1 = getDoc(name);
    const m1 = getCanvasUndoManager(doc1, name);

    destroyDoc(name); // doc destroyed + evicted from the doc cache
    const doc2 = getDoc(name); // new instance, same name
    expect(doc2).not.toBe(doc1);

    const m2 = getCanvasUndoManager(doc2, name);
    expect(m2).not.toBe(m1); // healed: a new manager bound to the live doc
    addNode('proj-f', 'space-f', makeNode('F'));
    expect(m2.canUndo()).toBe(true); // tracks edits on the NEW doc
  });

  it('invariant 7 — a vanished (deleted) space gets its undo manager evicted; live ones are untouched', () => {
    // Closing a tab routes through onCloseTab (handled). But DELETING a space
    // (local or remote collaborator) drops the tab via ProjectPage's openTabs
    // filter WITHOUT calling onCloseTab. This reconcile must still clear the
    // gone space's undo manager — else it leaks and a restore-under-same-id
    // resurfaces the stale pre-delete stack.
    const p = 'proj-del';
    const nameKeep = docName.canvasSpace(p, 'sp-keep');
    const nameGone = docName.canvasSpace(p, 'sp-gone');
    const mKeep = getCanvasUndoManager(getDoc(nameKeep), nameKeep);
    const mGone = getCanvasUndoManager(getDoc(nameGone), nameGone);
    addNode(p, 'sp-keep', makeNode('k'));
    addNode(p, 'sp-gone', makeNode('g'));
    expect(mKeep.canUndo()).toBe(true);
    expect(mGone.canUndo()).toBe(true);

    // sp-gone vanished from the live spaces; sp-keep is still open AND live.
    evictUndoForVanishedSpaces(p, ['sp-keep', 'sp-gone'], new Set(['sp-keep']));

    // Keep: same instance, stack intact.
    expect(getCanvasUndoManager(getDoc(nameKeep), nameKeep)).toBe(mKeep);
    expect(mKeep.canUndo()).toBe(true);
    // Gone: evicted → re-get is a fresh empty manager.
    const mGone2 = getCanvasUndoManager(getDoc(nameGone), nameGone);
    expect(mGone2).not.toBe(mGone);
    expect(mGone2.canUndo()).toBe(false);
  });

  it('invariant 5 — reset gives a fresh empty manager (page refresh = new JS context)', () => {
    const name = docName.canvasSpace('proj-e', 'space-e');
    const doc1 = getDoc(name);
    const m1 = getCanvasUndoManager(doc1, name);
    addNode('proj-e', 'space-e', makeNode('E'));
    expect(m1.canUndo()).toBe(true);

    _resetCanvasUndoCacheForTests();
    _resetForTests();

    const doc2 = getDoc(name);
    const m2 = getCanvasUndoManager(doc2, name);
    expect(m2).not.toBe(m1);
    expect(m2.canUndo()).toBe(false);
  });
});
