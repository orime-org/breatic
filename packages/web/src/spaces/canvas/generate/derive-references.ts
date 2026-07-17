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
  /**
   * True for a FOCUS crop pool row (#1782) — a standalone copy, not an edge
   * projection: its `refId` / `sourceNodeId` live in the `focus:` namespace,
   * its name / thumbnail are creation-time snapshots that never follow the
   * source node, and its ✕ removes the crop (never an edge). Absent = a
   * normal node-reference row.
   */
  focus?: true;
}

/**
 * The id namespace marking focus-crop pool rows (#1782). Prefixing keeps
 * crop ids and node ids unmistakable everywhere one set flows through the
 * other's plumbing (mention attrs, @ extraction, rail removal routing).
 */
export const FOCUS_REF_PREFIX = 'focus:';

/**
 * Builds the namespaced pool id for a focus crop.
 * @param focusId - The FocusImage id.
 * @returns The `focus:`-prefixed id used as refId / sourceNodeId.
 */
export function focusRefId(focusId: string): string {
  return `${FOCUS_REF_PREFIX}${focusId}`;
}

/**
 * Extracts the FocusImage id from a namespaced pool id.
 * @param refId - A pool refId / mention sourceNodeId.
 * @returns The FocusImage id, or null when the id is not in the focus namespace.
 */
export function focusIdOfRefId(refId: string): string | null {
  return refId.startsWith(FOCUS_REF_PREFIX)
    ? refId.slice(FOCUS_REF_PREFIX.length)
    : null;
}

/**
 * Maps a focus crop to a pool row (#1782) so the rail, the @ mention
 * suggestion, the chip live-lookup, and the pool-membership cascade all
 * handle crops through the exact same plumbing as node references. The
 * row is static by construction (snapshots — F, user 2026-07-16).
 * @param crop - The stored FocusImage.
 * @param crop.id - The FocusImage id.
 * @param crop.url - The crop asset URL (row thumbnail).
 * @param crop.name - The creation-time source-name snapshot.
 * @returns The focus pool row.
 */
export function focusToRailItem(crop: {
  id: string;
  url: string;
  name: string;
}): ReferenceRailItem {
  return {
    refId: focusRefId(crop.id),
    sourceNodeId: focusRefId(crop.id),
    sourceNodeType: 'image',
    sourceNodeName: crop.name,
    thumbnail: crop.url,
    focus: true,
  };
}

/**
 * Compares two edge ids by CODE UNIT (ordinal), not locale. The tiebreak must
 * be identical on every client, and `String.prototype.localeCompare` collates
 * in the runtime's default locale — under da/nb the 'aa' hex digraph sorts
 * after 'z', so a Danish client would order tied references differently than
 * an English one, defeating the cross-client determinism this exists for
 * (adversarial round-2).
 * @param a - First edge id.
 * @param b - Second edge id.
 * @returns Negative, zero, or positive per ordinal order.
 */
function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  // caller's edges. Ties (all unstamped legacy edges; same-ms stamps) break
  // by edge id — the input order is Y.Map struct-store order, which DIFFERS
  // across clients mid-session and flips on reload, so "stable sort keeps
  // legacy order" would just reproduce the nondeterminism the stamp exists
  // to remove (adversarial round-1). The id tiebreak gives every client the
  // identical rail (and i2i payload) order.
  const incoming = edges
    // The row's refId = the edge id, so the focus: namespace guard applies
    // to EDGE ids too (round-12): a forged edge id colliding with a crop's
    // pool id would render two rail rows with the same React key and
    // misroute the ✕ removal. Legit edge ids are UUID-based and never
    // carry the prefix.
    .filter((e) => e.target === nodeId && !e.id.startsWith(FOCUS_REF_PREFIX))
    .sort(
      (a, b) =>
        (a.createdAt ?? 0) - (b.createdAt ?? 0) || ordinalCompare(a.id, b.id),
    );
  const rail: ReferenceRailItem[] = [];
  for (const edge of incoming) {
    const source = byId.get(edge.source);
    if (!source) continue;
    // The focus: namespace belongs to crops exclusively (round-9): a
    // forged canvas NODE whose id squats in it would collide with a crop's
    // pool id — one @-mention would then pull BOTH the crop and the forged
    // node's content into the payload. Legit node ids are UUIDs and never
    // carry the prefix.
    if (source.id.startsWith(FOCUS_REF_PREFIX)) continue;
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
