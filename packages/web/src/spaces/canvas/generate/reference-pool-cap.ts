// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Reference-pool cap math (#1782).
 *
 * One node's reference pool = its incoming reference edges (a connection
 * IS a reference) + its focus crops (`data.focusImages`) combined. The
 * pool is capped per node by the `canvas_reference_pool_cap` knob
 * (config/limits.yaml → GET /canvas/limits) — a UI sanity cap enforced by
 * the frontend at ADD time (connect / pick click / focus confirm); the
 * pool lives in Yjs, so the server never gates collaborative writes and a
 * concurrent-add overshoot is accepted (soft cap). Distinct from the
 * per-model `images.max_items` payload cap enforced at execute (#1735).
 */

import { validFocusImages } from '@web/data/focus-images';

/** The minimal edge shape the count reads (ReactFlow edge compatible). */
interface PoolEdge {
  source: string;
  target: string;
}

/** The minimal node shape the count reads (graph-store mirror compatible). */
interface PoolNode {
  id: string;
  data?: { focusImages?: unknown };
}

/**
 * Count the target node's current reference pool: incoming edges + VALID
 * focus crops. Counting only what {@link validFocusImages} accepts keeps
 * this in exact agreement with what the panel renders — counting raw
 * entries would let malformed remote data occupy invisible, UI-unremovable
 * cap slots (adversarial 2026-07-16).
 * @param edges - The canvas edges (only `target` is read).
 * @param nodes - The canvas nodes (only the target's `data.focusImages` is read).
 * @param targetId - The node whose pool to count.
 * @returns The pool entry count.
 */
export function referencePoolCount(
  edges: ReadonlyArray<PoolEdge>,
  nodes: ReadonlyArray<PoolNode>,
  targetId: string,
): number {
  // Count only edges whose SOURCE resolves — the same predicate the rail's
  // deriveReferences applies. A dangling edge (source deleted concurrently
  // with the connect) renders no row and has no ✕, so counting it would be
  // an invisible, UI-unremovable cap slot (adversarial round-2 2026-07-16).
  const ids = new Set(nodes.map((n) => n.id));
  const edgeCount = edges.filter(
    (e) => e.target === targetId && ids.has(e.source),
  ).length;
  const focusImages = nodes.find((n) => n.id === targetId)?.data?.focusImages;
  return edgeCount + validFocusImages(focusImages).length;
}

/**
 * Whether the target node's reference pool is at (or past) the cap — the
 * gate check run before adding an entry (a new edge or a focus crop).
 * @param edges - The canvas edges (only `target` is read).
 * @param nodes - The canvas nodes (only the target's `data.focusImages` is read).
 * @param targetId - The node whose pool to check.
 * @param cap - The pool cap (from {@link getCachedReferencePoolCap}).
 * @returns True when the pool already holds `cap` or more entries.
 */
export function isReferencePoolFull(
  edges: ReadonlyArray<PoolEdge>,
  nodes: ReadonlyArray<PoolNode>,
  targetId: string,
  cap: number,
): boolean {
  return referencePoolCount(edges, nodes, targetId) >= cap;
}
