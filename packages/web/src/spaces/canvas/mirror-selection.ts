// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Edge, Node } from '@xyflow/react';

/**
 * Shallow-equal two node `data` records by their own enumerable keys (values
 * compared with `Object.is`). The Yjs mirror rebuilds each node's `data` fresh
 * every doc change, so a reference compare is always false; this compares the
 * flat fields (content / status / name / locked / …). A nested object inside
 * data (e.g. an active `handlingBy` lease) compares by reference and so reads as
 * changed — correct, since a handling node IS actively changing.
 * @param a - One node's data record (or undefined).
 * @param b - The other node's data record (or undefined).
 * @returns True when both have identical own keys with `Object.is`-equal values.
 */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    Object.is(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/**
 * Whether two ReactFlow nodes have identical render inputs, so the previous
 * object reference can be reused. Compares every field `toFlowNode` sets (type,
 * position, parentId, group width/height) plus the carried local flags
 * (selected / dragging) and `data` (shallow). Reusing the reference for
 * unchanged nodes is what lets `React.memo` bail — otherwise a change to ONE
 * node hands ALL nodes a fresh object and every node re-renders (#1647 R1).
 * @param a - The previous render-buffer node.
 * @param b - The freshly merged node.
 * @returns True when nothing that affects rendering changed.
 */
function sameRenderInputs(a: Node, b: Node): boolean {
  return (
    a.type === b.type &&
    a.parentId === b.parentId &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.selected === b.selected &&
    a.dragging === b.dragging &&
    a.hidden === b.hidden &&
    sameData(a.data, b.data)
  );
}

/**
 * Merge local selection state into a freshly mirrored node array. Yjs is the
 * source of truth for node data / position, but **selection (and an in-flight
 * drag) is per-user local UI state** that does not live in Yjs. The mirror
 * rebuilds the whole ReactFlow node array from Yjs on every doc change, so
 * without this merge a collaborator / backend write to any node would wipe the
 * current user's selection (including the just-created node's auto-selection).
 *
 * Selection / drag flags are carried forward by id; everything else (data,
 * position) comes from the fresh nodes. Brand-new nodes (not in `prev`) are
 * left as-is — the auto-select effect selects a freshly created node
 * explicitly once it appears.
 *
 * **Reference stability (#1647)**: for a node whose render inputs are unchanged,
 * the PREVIOUS object reference is reused (not a fresh `{...node}`), so
 * `React.memo` on the node body bails and only the node that actually changed
 * re-renders. Without this, the mirror hands every node a new reference on every
 * doc change and memo never bails.
 * @param prev - The previous render buffer (holds local selection / drag).
 * @param fresh - The nodes freshly mapped from the Yjs mirror.
 * @returns The fresh nodes with local selection / drag preserved and unchanged
 *   nodes' previous references reused.
 */
export function mergeMirroredSelection(
  prev: ReadonlyArray<Node>,
  fresh: ReadonlyArray<Node>,
): Node[] {
  const prevById = new Map(prev.map((node) => [node.id, node]));
  return fresh.map((node) => {
    const p = prevById.get(node.id);
    if (!p) return node; // brand-new node
    const merged = { ...node, selected: p.selected, dragging: p.dragging };
    return sameRenderInputs(p, merged) ? p : merged;
  });
}

/**
 * Rewrites the `selected` flag across a render buffer, reusing the previous
 * array reference when nothing changes. Programmatic selection writes (panel
 * host assert, pane-click deselect) run on high-frequency paths, and
 * publishing a fresh array identity for a no-op write would re-render the
 * whole canvas (reference-stability discipline, #1647). Unchanged items keep
 * their object reference so `React.memo` on node bodies still bails.
 * @param current - The current render buffer (nodes or edges).
 * @param shouldSelect - Decides each item's target selected state.
 * @returns The rewritten buffer, or `current` itself when nothing changed.
 */
export function reconcileSelection<T extends { id: string; selected?: boolean }>(
  current: ReadonlyArray<T>,
  shouldSelect: (item: T) => boolean,
): T[] {
  let changed = false;
  const mapped = current.map((item) => {
    const target = shouldSelect(item);
    if ((item.selected === true) === target) return item;
    changed = true;
    return { ...item, selected: target };
  });
  return changed ? mapped : (current as T[]);
}

/**
 * Edge counterpart of {@link mergeMirroredSelection}: carry the per-user local
 * `selected` flag forward by id when rebuilding the edge array from the Yjs
 * mirror. Without this the freshly-mirrored edges (rebuilt on every Yjs change)
 * would have no selection, so the scissors-delete affordance — gated on the
 * edge being selected — could never appear, and the delete key would have no
 * selected edge to remove. Edges have no drag state, so only `selected` is
 * carried.
 * @param prev - The previous edge render buffer (holds local selection).
 * @param fresh - The edges freshly mapped from the Yjs mirror.
 * @returns The fresh edges with local `selected` flags preserved by id.
 */
export function mergeMirroredEdgeSelection(
  prev: ReadonlyArray<Edge>,
  fresh: ReadonlyArray<Edge>,
): Edge[] {
  const local = new Map(prev.map((edge) => [edge.id, edge.selected]));
  return fresh.map((edge) => {
    const selected = local.get(edge.id);
    return selected === undefined ? edge : { ...edge, selected };
  });
}
