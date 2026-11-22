// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PT-4 (#1580 test spec §4, invariant I5): a page and collab each hold the canvas document and sync at random
 * moments. The page starts crops on random nodes; collab appends uploaded crops with the shared append, sometimes
 * twice (a replayed event) and sometimes onto a node already gone; either side deletes nodes, and the page undoes a
 * delete. At every point the page's pending entries for a node are exactly its crops still not in that node's pool
 * on the page, for nodes the page still holds; and no pool ever holds one id twice.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';
import { appendFocusImageCore } from '@breatic/shared/space-content';
import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { watchPendingFocusUploads } from '@web/spaces/canvas/focus/pending-focus-uploads';

const NODES = ['n0', 'n1', 'n2'];

type Step =
  | { kind: 'crop'; node: number }
  | { kind: 'append'; crop: number; twice: boolean }
  | { kind: 'delete'; node: number; side: 'page' | 'collab' }
  | { kind: 'undo' }
  | { kind: 'sync'; toPage: boolean; toCollab: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('crop' as const), node: fc.integer({ min: 0, max: 2 }) }),
  fc.record({ kind: fc.constant('append' as const), crop: fc.integer({ min: 0, max: 7 }), twice: fc.boolean() }),
  fc.record({ kind: fc.constant('delete' as const), node: fc.integer({ min: 0, max: 2 }), side: fc.constantFrom('page', 'collab') as fc.Arbitrary<'page' | 'collab'> }),
  fc.record({ kind: fc.constant('undo' as const) }),
  fc.record({ kind: fc.constant('sync' as const), toPage: fc.boolean(), toCollab: fc.boolean() }),
);

/**
 * A node's data map in `doc`, if the node is there.
 * @param doc - The document.
 * @param nodeId - The node.
 * @returns Its data map, or undefined.
 */
function dataOf(doc: Y.Doc, nodeId: string): Y.Map<unknown> | undefined {
  return (doc.getMap(CANVAS_NODES_KEY).get(nodeId) as Y.Map<unknown> | undefined)?.get('data') as Y.Map<unknown> | undefined;
}

/**
 * The ids in a node's pool in `doc`.
 * @param doc - The document.
 * @param nodeId - The node.
 * @returns The ids, in order.
 */
function poolIds(doc: Y.Doc, nodeId: string): string[] {
  const pool = dataOf(doc, nodeId)?.get('focusImages');
  return pool instanceof Y.Array ? (pool.toArray() as { id: string }[]).map((f) => f.id) : [];
}

describe('PT-4 pending focus crops under any interleaving of page, collab and sync', () => {
  it('keeps the pending entries equal to the crops not yet in the pool, with no id twice and no write to a missing node', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const page = new Y.Doc();
        const nodes = page.getMap(CANVAS_NODES_KEY);
        for (const id of NODES) {
          const node = new Y.Map<unknown>();
          const data = new Y.Map<unknown>();
          node.set('type', 'image');
          node.set('data', data);
          nodes.set(id, node);
          data.set('focusImages', new Y.Array<unknown>());
        }
        const collab = new Y.Doc();
        Y.applyUpdate(collab, Y.encodeStateAsUpdate(page));
        const undo = new Y.UndoManager(nodes);
        const session = createCanvasSessionStore();
        const stop = watchPendingFocusUploads(page, session);
        const crops: { id: string; node: string }[] = [];
        try {
          for (const s of steps) {
            if (s.kind === 'crop') {
              const node = NODES[s.node]!;
              if (!nodes.has(node)) continue;
              const crop = { id: `crop-${crops.length}`, node };
              crops.push(crop);
              session.getState().addPendingFocusUpload({ id: crop.id, nodeId: node, name: 'S' });
            } else if (s.kind === 'append') {
              const crop = crops[s.crop];
              if (crop === undefined) continue;
              for (let i = 0; i < (s.twice ? 2 : 1); i += 1) {
                // Collab writes only to a node it holds (task-listener's rule); a node gone there is skipped.
                const data = dataOf(collab, crop.node);
                if (data === undefined) continue;
                collab.transact(() => {
                  appendFocusImageCore(data, { id: crop.id, url: `https://assets.example.test/${crop.id}.png`, name: 'S', width: 10, height: 10 });
                });
              }
            } else if (s.kind === 'delete') {
              (s.side === 'page' ? nodes : collab.getMap(CANVAS_NODES_KEY)).delete(NODES[s.node]!);
            } else if (s.kind === 'undo') {
              undo.undo();
            } else {
              if (s.toPage) Y.applyUpdate(page, Y.encodeStateAsUpdate(collab, Y.encodeStateVector(page)));
              if (s.toCollab) Y.applyUpdate(collab, Y.encodeStateAsUpdate(page, Y.encodeStateVector(collab)));
            }
            for (const node of NODES) {
              const pending = session.getState().pendingFocusUploads.filter((p) => p.nodeId === node).map((p) => p.id).sort();
              const ids = poolIds(page, node);
              expect(new Set(ids).size).toBe(ids.length);
              expect(new Set(poolIds(collab, node)).size).toBe(poolIds(collab, node).length);
              for (const id of pending) expect(ids).not.toContain(id);
              if (!nodes.has(node)) expect(pending).toEqual([]);
            }
          }
        } finally {
          stop();
        }
      }),
      { numRuns: 200 },
    );
  });
});
