// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import {
  CANVAS_UNDO,
  createCanvasUndoManager,
} from '@web/data/yjs/canvas-space';

/**
 * Invariant (decision 2026-06-20): lock does NOT block undo. Undo is per-user
 * and operates directly on the Yjs doc via `Y.UndoManager`, BELOW the
 * `onBeforeDelete` lock guard — so a creator can always undo their own
 * creation, even after another collaborator locked the object. This guards
 * against a future change that wrongly makes undo respect the lock (which would
 * desync the user's own undo stack, see lock-semantics design §2).
 */
describe('canvas undo × lock invariant — lock does NOT block undo', () => {
  it('undo removes a node it created even after a remote collaborator locked it', () => {
    const doc = new Y.Doc();
    const undo = createCanvasUndoManager(doc);
    const nodesMap = doc.getMap<Y.Map<unknown>>('nodesMap');

    // User A creates node X (a CANVAS_UNDO-origin write → tracked in A's stack).
    doc.transact(() => {
      const node = new Y.Map<unknown>();
      node.set('id', 'x');
      node.set('type', 'text');
      node.set('data', new Y.Map<unknown>());
      nodesMap.set('x', node);
    }, CANVAS_UNDO);
    expect(nodesMap.has('x')).toBe(true);

    // User B locks X — a remote write (NOT a CANVAS_UNDO origin), so it never
    // enters A's undo stack. This is the A-creates / B-locks / A-undoes race.
    doc.transact(() => {
      const data = (nodesMap.get('x') as Y.Map<unknown>).get(
        'data',
      ) as Y.Map<unknown>;
      data.set('locked', true);
    }, 'remote-sync');
    const lockedData = (nodesMap.get('x') as Y.Map<unknown>).get(
      'data',
    ) as Y.Map<unknown>;
    expect(lockedData.get('locked')).toBe(true);

    // A undoes their own creation — the lock must NOT veto it (undo is below the
    // delete guard). X is removed.
    undo.undo();
    expect(nodesMap.has('x')).toBe(false);
  });
});
