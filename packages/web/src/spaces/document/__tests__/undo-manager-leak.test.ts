// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Destroying our undo manager must leave nothing behind on the Y.Doc.
 *
 * `Y.UndoManager`'s constructor registers a `doc.on('destroy', …)` listener
 * that its own `destroy()` never removes — the manager's other listener is
 * cleaned up, this one is not. y-tiptap works around it by diffing the doc's
 * destroy observers around construction and detaching the difference on
 * teardown, but only for a manager the plugin builds itself.
 *
 * Neither of our managers is one the plugin builds, so the cleanup is ours —
 * for BOTH of them. Skip it and every teardown that leaves the Y.Doc alive
 * strands a dead manager, with its undo and redo stacks and the deleted content
 * those stacks keep alive through `keepItem`, permanently reachable from a
 * document that now never dies.
 *
 * Listed together on purpose: the document manager was fixed first and the
 * canvas one was left with the identical bug for a while.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { createCanvasUndoManager } from '@web/data/yjs/canvas-space';
import { createDocumentUndoManager } from '@web/spaces/document/document-undo';

/** Reach the doc's observer registry the way y-tiptap's own workaround does. */
function destroyListenerCount(doc: Y.Doc): number {
  const observers = (
    doc as unknown as {
      _observers?: Map<string, Set<unknown>>;
    }
  )._observers;
  return observers?.get('destroy')?.size ?? 0;
}

/** Every undo manager we build. Both have the same leak and the same wrapper. */
const UNDO_MANAGERS: ReadonlyArray<{
  name: string;
  create: (doc: Y.Doc) => { destroy: () => void };
}> = [
  { name: 'document', create: createDocumentUndoManager },
  { name: 'canvas', create: createCanvasUndoManager },
];

describe('an undo manager', () => {
  for (const target of UNDO_MANAGERS) {
    it(`detaches everything it attached to the Y.Doc: ${target.name}`, () => {
      const doc = new Y.Doc();
      const before = destroyListenerCount(doc);

      const manager = target.create(doc);
      expect(destroyListenerCount(doc)).toBeGreaterThan(before);

      manager.destroy();

      // The Y.Doc outlives the manager whenever a tab is closed and reopened
      // before the deferred teardown runs — a re-acquire cancels it — so this
      // is the difference between a bounded session and one that accumulates a
      // dead manager per cycle.
      expect(destroyListenerCount(doc)).toBe(before);
      doc.destroy();
    });
  }
});
