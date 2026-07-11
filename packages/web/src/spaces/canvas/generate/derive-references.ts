// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reference rail derivation — "a connection IS a reference".
 *
 * A generative node's reference rail is NOT stored separately: it is derived
 * live from the node's incoming canvas edges (single source of truth =
 * `edgesMap`, zero drift). Each incoming edge (`edge.target === nodeId`)
 * yields one rail row; display fields (`sourceNodeName`, `thumbnail`) are read
 * live from the current source node, so renaming or re-generating the source
 * updates the rail automatically. Adding a reference = drawing an edge;
 * removing a reference (rail ✕) or deleting the edge = removing the edge —
 * both are frontend-owned and never involve the worker.
 */

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { NodeKind, NodeView } from '@web/spaces/canvas/types/node-view';

/** One derived reference rail row (view-model, not stored in Yjs). */
export interface ReferenceRailItem {
  /** Stable id for this row = the backing edge id. */
  refId: string;
  /** Upstream node feeding this reference = the edge source. */
  sourceNodeId: string;
  /** Upstream node modality. */
  sourceNodeType: NodeKind;
  /** Live display name of the upstream node (updates as it is renamed). */
  sourceNodeName: string;
  /** Live thumbnail / preview URL when the upstream carries a visual payload. */
  thumbnail?: string;
  /**
   * Live text body when the upstream is a text node (spec §9.1): feeds the
   * backend-prompt chip substitution and the rail hover preview.
   */
  textContent?: string;
}

/**
 * Reads a source node view's display name. Content and group views carry an
 * optional `name`; an annotation sticky has none, so it resolves to empty.
 * @param view - The source node's view.
 * @returns The display name, or empty string when the view carries none.
 */
function nameOf(view: NodeView): string {
  return ('name' in view ? view.name : undefined) ?? '';
}

/**
 * Picks the live thumbnail URL for a source node view: the image asset for an
 * image, the cover frame (falling back to the raw asset) for a video, and
 * nothing for modalities without a visual payload (text / audio / 3d / web /
 * annotation / group).
 * @param view - The source node's view.
 * @returns The thumbnail URL, or undefined when there is no visual payload.
 */
function thumbnailOf(view: NodeView): string | undefined {
  switch (view.kind) {
    case 'image':
      return view.content;
    case 'video':
      return view.coverUrl ?? view.content;
    default:
      return undefined;
  }
}

/**
 * Derives a node's reference rail from its incoming edges. Every edge whose
 * `target` is `nodeId` becomes one rail row resolved against the current node
 * set; a dangling edge (source node absent) is skipped. Rows are ordered by
 * connection time (`createdAt` ascending, newest last — batch-2 item 7), NOT
 * by array position: the edges array mirrors Y.Map struct-store order, which
 * diverges from insertion order after reload / cross-client sync. A legacy
 * edge without a stamp sorts as oldest (stable among its peers). Pure —
 * display fields reflect the source nodes as passed in.
 * @param nodeId - The generative node whose reference rail to build.
 * @param nodes - The current canvas node views (source of live display
 *   fields). Only `id` + `data` are read, so both the stored
 *   {@link CanvasNodeView} shape and ReactFlow's `Node<NodeView>` satisfy it.
 * @param edges - The current canvas edges.
 * @returns The reference rail rows, in connection-time order (newest last).
 */
export function deriveReferences(
  nodeId: string,
  nodes: ReadonlyArray<Pick<CanvasNodeView, 'id' | 'data'>>,
  edges: ReadonlyArray<CanvasEdge>,
): ReferenceRailItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // filter() returns a fresh array, so the in-place sort never mutates the
  // caller's edges. Array.prototype.sort is stable, so unstamped legacy edges
  // (?? 0) keep their relative order while preceding every stamped edge.
  const incoming = edges
    .filter((e) => e.target === nodeId)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const rail: ReferenceRailItem[] = [];
  for (const edge of incoming) {
    const source = byId.get(edge.source);
    if (!source) continue;
    rail.push({
      refId: edge.id,
      sourceNodeId: source.id,
      sourceNodeType: source.data.kind,
      sourceNodeName: nameOf(source.data),
      thumbnail: thumbnailOf(source.data),
      textContent:
        source.data.kind === 'text' ? source.data.content : undefined,
    });
  }
  return rail;
}
