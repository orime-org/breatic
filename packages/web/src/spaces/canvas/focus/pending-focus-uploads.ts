// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page's pending focus crops (#1580). The server adds an uploaded crop to its node's pool; until an image with the
 * crop's id appears in that pool, the page keeps a pending entry that every pool-cap gate counts. The entry goes when
 * the image arrives, in the same document update, so the pool never reads one short, and with its node when the node
 * leaves the document, as a canvas upload's state goes with its node. A failed upload drops its entry where the
 * failure is reported.
 */

import * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';

import type { CanvasSessionStore } from '@web/stores/canvas-session';

/**
 * Whether a node's pool in `nodes` holds an image with `id`.
 * @param nodes - The document's node map.
 * @param nodeId - The node.
 * @param id - The crop's id.
 * @returns True once the image is there.
 */
function poolHolds(nodes: Y.Map<unknown>, nodeId: string, id: string): boolean {
  const node = nodes.get(nodeId);
  const pool = node instanceof Y.Map ? (node.get('data') as Y.Map<unknown> | undefined)?.get('focusImages') : undefined;
  const items: unknown[] = pool instanceof Y.Array ? pool.toArray() : Array.isArray(pool) ? pool : [];
  return items.some((f) => typeof f === 'object' && f !== null && (f as { id?: unknown }).id === id);
}

/**
 * Drop pending entries whose image arrived or whose node is gone, on every change to the canvas document's nodes.
 * @param doc - The canvas Space document.
 * @param session - The Space's session store.
 * @returns Stops watching.
 */
export function watchPendingFocusUploads(doc: Y.Doc, session: CanvasSessionStore): () => void {
  const nodes = doc.getMap<unknown>(CANVAS_NODES_KEY);
  /** Settle every pending entry against the document as it now stands. */
  const settle = (): void => {
    const state = session.getState();
    for (const entry of state.pendingFocusUploads) {
      if (!nodes.has(entry.nodeId) || poolHolds(nodes, entry.nodeId, entry.id)) state.removePendingFocusUpload(entry.id);
    }
  };
  // Deep observers run inside the transaction's cleanup, before `afterTransaction`, so the entry and its image
  // never both count or both miss.
  nodes.observeDeep(settle);
  return (): void => nodes.unobserveDeep(settle);
}
