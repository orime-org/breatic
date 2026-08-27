// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Edge, Node } from '@xyflow/react';

/**
 * `Object.is` with ONE array-aware level (encoding adversary 2026-07-17):
 * the Yjs mirror serializes a nested `Y.Array` (`focusImages`, eager-seeded
 * on EVERY node) to a FRESH plain array on each `toJSON()` call, so
 * whole-array identity is false on every doc change even when nothing
 * changed — which would hand all nodes fresh merged objects and revert the
 * #1647 R1 reference-stability fix canvas-wide. `Y.Array.toJSON` returns
 * its ELEMENTS by stored reference (identity-stable until an element
 * actually changes), so element-wise `Object.is` is exact and cheap; a
 * plain-array value (legacy encoding) short-circuits on the whole-array
 * identity first.
 * @param a - One field value.
 * @param b - The other field value.
 * @returns True when the values are identical, or are equal-length arrays
 *   of identical elements.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((v, i) => Object.is(v, b[i]));
}

/**
 * Shallow-equal two node `data` records by their own enumerable keys (values
 * compared with {@link sameValue}). The Yjs mirror rebuilds each node's `data`
 * fresh every doc change, so a reference compare is always false; this compares
 * the flat fields (content / status / name / locked / …) and array fields
 * element-wise. A nested non-array object inside data (`paramsByModel` /
 * `modelByMode` — whole-object rewrites whose stored reference is stable via
 * `toJSON` until actually replaced) compares by reference: unchanged → same
 * ref → equal; rewritten → new ref → changed. (`toNodeView` folds the wire
 * `handlingBy` into two flat fields — the derived `status` string and the
 * starter's `handlingByUserId` — so both a handling transition and a
 * generation changing hands are caught by the value compare above.)
 * @param a - One node's data record (or undefined).
 * @param b - The other node's data record (or undefined).
 * @returns True when both have identical own keys with {@link sameValue}-equal
 *   values.
 */
export function sameData(a: unknown, b: unknown): boolean {
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
    sameValue(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
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
 * Whether two ReactFlow edges have identical render inputs, so the previous
 * object reference can be reused. Compares the structural fields `toFlowEdge`
 * sets (source / target / type), the carried local `selected` flag, and `data`
 * (shallow — the edge carries `{ readOnly }`, rebuilt fresh every Yjs change).
 * Reusing the reference for unchanged edges is what lets `ScissorsEdge`'s
 * `React.memo` bail — otherwise a change to ANY node/edge hands EVERY edge a
 * fresh object and every scissors edge re-renders (edge counterpart of the node
 * mirror's #1647 R1 fix).
 * @param a - The previous render-buffer edge.
 * @param b - The freshly merged edge.
 * @returns True when nothing that affects rendering changed.
 */
function sameEdgeRenderInputs(a: Edge, b: Edge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.type === b.type &&
    a.selected === b.selected &&
    a.hidden === b.hidden &&
    sameData(a.data, b.data)
  );
}

/**
 * Edge counterpart of the node merge (`merge-canvas-nodes.ts`): carry the
 * per-user local
 * `selected` flag forward by id when rebuilding the edge array from the Yjs
 * mirror. Without this the freshly-mirrored edges (rebuilt on every Yjs change)
 * would have no selection, so the scissors-delete affordance — gated on the
 * edge being selected — could never appear, and the delete key would have no
 * selected edge to remove. Edges have no drag state, so only `selected` is
 * carried.
 *
 * **Reference stability (#1783)**: for an edge whose render inputs are unchanged,
 * the PREVIOUS object reference is reused (not a fresh `{...edge}`), so
 * `ScissorsEdge`'s `React.memo` bails and only the edge that actually changed
 * re-renders — the same reconciliation the node mirror already applies.
 * @param prev - The previous edge render buffer (holds local selection).
 * @param fresh - The edges freshly mapped from the Yjs mirror.
 * @returns The fresh edges with local `selected` flags preserved and unchanged
 *   edges' previous references reused.
 */
export function mergeMirroredEdgeSelection(
  prev: ReadonlyArray<Edge>,
  fresh: ReadonlyArray<Edge>,
): Edge[] {
  const prevById = new Map(prev.map((edge) => [edge.id, edge]));
  return fresh.map((edge) => {
    const p = prevById.get(edge.id);
    if (!p) return edge; // brand-new edge — no local selection to carry
    const merged =
      p.selected === undefined ? edge : { ...edge, selected: p.selected };
    return sameEdgeRenderInputs(p, merged) ? p : merged;
  });
}

/**
 * Deep-equal two `groupResizeBounds` arrays (an array of flat number records —
 * one min/max clamp per resize control). `renderNodes` recomputes this array
 * with FRESH element objects on every pass, so element `Object.is` is always
 * false; comparing the numbers lets an unchanged group reuse its previous render
 * node so `GroupNode`'s `React.memo` bails (#1783).
 * @param a - One bounds array (or any value).
 * @param b - The other bounds array (or any value).
 * @returns True when both are equal-length arrays of field-wise equal records.
 */
export function sameGroupResizeBounds(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  return a.every((x, i) => {
    const y = b[i];
    if (
      typeof x !== 'object' ||
      x === null ||
      typeof y !== 'object' ||
      y === null
    ) {
      return Object.is(x, y);
    }
    const xk = Object.keys(x as Record<string, unknown>);
    const yk = Object.keys(y as Record<string, unknown>);
    return (
      xk.length === yk.length &&
      xk.every((k) =>
        Object.is(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
        ),
      )
    );
  });
}

/**
 * `sameData` for a group render node: the derived `data` is `{...node.data,
 * groupResizeBounds}`, so `groupResizeBounds` is compared with the bounds-aware
 * {@link sameGroupResizeBounds} (fresh array each pass) and every other field
 * with {@link sameValue}.
 * @param a - One group node's data record.
 * @param b - The other group node's data record.
 * @returns True when the records are field-wise equal.
 */
function sameGroupData(a: unknown, b: unknown): boolean {
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
  return ak.every((k) => {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    return k === 'groupResizeBounds'
      ? sameGroupResizeBounds(av, bv)
      : sameValue(av, bv);
  });
}

/**
 * Whether two group render nodes have identical render inputs. Like the node
 * merge's own comparison (`merge-canvas-nodes.ts`) but adds the derived
 * `draggable` / `zIndex` `renderNodes` sets, and leaves the `data` comparison
 * to the caller: a group's carries a rebuilt bounds array, a plain node's is
 * handed down whole.
 * @param a - The previous render node.
 * @param b - The freshly built render node.
 * @param sameData - How to compare the two nodes' data records.
 * @returns True when nothing that affects rendering changed.
 */
function sameRenderInputs(
  a: Node,
  b: Node,
  sameData: (x: unknown, y: unknown) => boolean,
): boolean {
  return (
    a.parentId === b.parentId &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.selected === b.selected &&
    a.dragging === b.dragging &&
    a.hidden === b.hidden &&
    a.draggable === b.draggable &&
    a.zIndex === b.zIndex &&
    sameData(a.data, b.data)
  );
}

/**
 * Reference-reconcile freshly-built group render nodes against the previous
 * render pass. `renderNodes` rebuilds every group's `data` (with a fresh
 * `groupResizeBounds` array) on every canvas mutation, so without this a change
 * to ANY node hands EVERY group a fresh object and every `GroupNode` re-renders.
 * Reuse the previous object reference for a group whose render inputs are
 * unchanged — the group counterpart of the node merge (#1783).
 * @param prev - The previous pass's group render nodes.
 * @param fresh - The freshly built group render nodes.
 * @returns The fresh groups with unchanged groups' previous references reused.
 */
export function reconcileGroupNodes(
  prev: ReadonlyArray<Node>,
  fresh: ReadonlyArray<Node>,
): Node[] {
  const prevById = new Map(prev.map((node) => [node.id, node]));
  return fresh.map((node) => {
    const p = prevById.get(node.id);
    return p && sameRenderInputs(p, node, sameGroupData) ? p : node;
  });
}

/**
 * Reference-reconcile freshly-flagged plain render nodes against the previous
 * pass. `renderNodes` builds a new object for a locked node and for the focus
 * target on every run, and during a gesture that run happens every frame — so
 * without reuse those nodes hand their `React.memo` a new reference 30 times a
 * second while nothing about them changed (#2010, acceptance 10).
 *
 * A plain node's `data` is passed down whole rather than rebuilt, so identity
 * is the right comparison: the merge stage already reuses that object when its
 * content is unchanged.
 * @param prev - Last pass's flagged nodes.
 * @param fresh - This pass's flagged nodes.
 * @returns The fresh array with unchanged entries swapped for their previous
 *   object.
 */
export function reconcilePlainNodes(
  prev: ReadonlyArray<Node>,
  fresh: ReadonlyArray<Node>,
): Node[] {
  const prevById = new Map(prev.map((node) => [node.id, node]));
  return fresh.map((node) => {
    const p = prevById.get(node.id);
    return p && sameRenderInputs(p, node, Object.is) ? p : node;
  });
}
