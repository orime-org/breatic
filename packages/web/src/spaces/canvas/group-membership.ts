// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure node-state set logic for the canvas: which nodes a lock or an in-flight
 * task freezes. Two lock SCOPES (user 2026-07-20): a node's OWN lock
 * (`data.locked`) freezes that node's everything (content / name / edit / move /
 * delete); a GROUP lock freezes only its members' GEOMETRY (move) and STRUCTURE
 * (delete / add) plus the group's own identity — it never freezes a member's
 * content / name / relations. So the group-aware set below (`lockedNodeIds` =
 * own-locked ∪ locked-group members) is wired ONLY into the move-freeze
 * (`renderNodes` draggable) and the node side of the delete guard; content
 * gates read each node's OWN `data.locked`, and EDGES (relations) are never
 * lock-gated. HANDLING freezes a node with a running task against deletion (and
 * the other content-affecting ops) but not against move / rename. The per-op
 * decision lives in {@link ./node-gate}.
 */

import type { NodeGateReason } from '@web/spaces/canvas/node-gate';

/**
 * Ids of every node that is a member of a *locked* Group — their position is
 * frozen, so the canvas renders them `draggable=false`. Membership is read from
 * each member's own `parentId` (group redesign 2026-06-23), so a locked
 * Group keeps its members fixed in place while the Group can still be dragged.
 * @param nodes - All canvas nodes (each member's `parentId` + each Group's `data.locked`).
 * @returns The set of member ids belonging to locked Groups.
 */
export function lockedGroupMemberIds(
  nodes: ReadonlyArray<{ id?: string; type?: string; parentId?: string; data?: unknown }>,
): Set<string> {
  const lockedGroups = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'group' || node.id === undefined) continue;
    if ((node.data as { locked?: boolean } | undefined)?.locked) {
      lockedGroups.add(node.id);
    }
  }
  const ids = new Set<string>();
  if (lockedGroups.size === 0) return ids;
  for (const node of nodes) {
    if (
      node.id !== undefined &&
      node.parentId !== undefined &&
      lockedGroups.has(node.parentId)
    ) {
      ids.add(node.id);
    }
  }
  return ids;
}

/**
 * Ids of every node frozen by a lock — any node with `data.locked`, OR a member
 * of a locked group. A frozen node can be neither moved (rendered
 * `draggable=false`) nor deleted ({@link filterGatedDeletion}); both reuse this
 * one set so they stay in lockstep. A locked group's OWN id is included, so the
 * whole group is frozen in place — it cannot be dragged as a unit (reverses
 * group-lock-C's whole-group drag, decision 2026-06-20).
 * @param nodes - All canvas nodes (the `locked` flag is read from each `data`).
 * @returns The set of node ids frozen by a lock.
 */
export function lockedNodeIds(
  nodes: ReadonlyArray<{ id: string; type?: string; parentId?: string; data?: unknown }>,
): Set<string> {
  const ids = lockedGroupMemberIds(nodes);
  for (const node of nodes) {
    if ((node.data as { locked?: boolean } | undefined)?.locked) ids.add(node.id);
  }
  return ids;
}

/**
 * Ids of every node currently `handling` a task (a task is writing it). A
 * handling node resists deletion — deleting it would strand the in-flight
 * write's result — but, unlike a lock, does NOT freeze position / name and has
 * no group-membership expansion (only content nodes handle). Kept separate from
 * {@link lockedNodeIds} so the move-freeze (draggable) path stays lock-only.
 *
 * Reads the DERIVED view field `data.status` (`idle` / `handling` / `error`),
 * NOT the wire field `data.state`: the delete guards feed this the ReactFlow
 * render buffer, whose data is a `NodeView` where `deriveStatus` has already
 * collapsed wire `state` into `status` (a lease-expired handling node becomes
 * `error`, correctly deletable). The wire `state` field is absent on the view —
 * reading it would silently return the empty set (adversarial round: the delete
 * gate was dead because a test fixture used the wire shape, masking it).
 * @param nodes - Canvas node VIEWS (each `data` is a NodeView carrying `status`).
 * @returns The set of node ids currently in the handling state.
 */
export function handlingNodeIds(
  nodes: ReadonlyArray<{ id: string; data?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if ((node.data as { status?: unknown } | undefined)?.status === 'handling') {
      ids.add(node.id);
    }
  }
  return ids;
}

/**
 * The ids to delete when the user deletes one node: just the node itself, UNLESS
 * it is a Group — deleting a Group deletes the WHOLE group (the Group frame plus
 * every member inside it, matched by `parentId`). The separate **ungroup** action
 * keeps the members on the canvas and only drops the frame; delete removes both.
 * @param targetId - The id of the node the user asked to delete.
 * @param nodes - All canvas nodes (each node's `type` + `parentId`).
 * @returns The set of node ids to delete (the target, plus its members when a Group).
 */
export function groupDeletionIds(
  targetId: string,
  nodes: ReadonlyArray<{ id: string; type?: string; parentId?: string }>,
): Set<string> {
  const ids = new Set<string>([targetId]);
  const target = nodes.find((node) => node.id === targetId);
  if (target?.type !== 'group') return ids;
  for (const node of nodes) {
    if (node.parentId === targetId) ids.add(node.id);
  }
  return ids;
}

/**
 * The ids to delete when the user deletes a multi-selection: the union of every
 * selected node's deletion set ({@link groupDeletionIds}), so a selection that
 * includes a Group removes that Group's members too — the same cascade the
 * single-node menu uses, applied across the whole selection. A member selected
 * alongside its Group is not duplicated (Set union).
 * @param targetIds - The ids of the selected nodes the user asked to delete.
 * @param nodes - All canvas nodes (each node's `type` + `parentId`).
 * @returns The set of node ids to delete (every selected node + members of any selected Group).
 */
export function selectionDeletionIds(
  targetIds: ReadonlyArray<string>,
  nodes: ReadonlyArray<{ id: string; type?: string; parentId?: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const targetId of targetIds) {
    for (const id of groupDeletionIds(targetId, nodes)) ids.add(id);
  }
  return ids;
}

/**
 * Partition a requested deletion so gated structure survives: any locked node
 * (a locked group OR a locked standalone node), a locked group's members, and
 * any node currently `handling` a task are kept OUT of the deletion. Wire into
 * ReactFlow's `onBeforeDelete` (the pre-delete veto) — the post-hoc `onDelete`
 * can't stop ReactFlow from removing nodes from the local buffer first, nor from
 * cascading a vetoed node's edges into the deletion.
 *
 * EDGES are logical RELATIONS, never content or geometry, so a lock (own OR
 * group) and `handling` NEVER gate them (user 2026-07-20 group-lock model; the
 * mirror of `onConnect` staying ungated). An edge is dropped from the deletion
 * (kept) only when it cascaded in alongside a VETOED (kept) node AND both its
 * endpoints survive — that node must retain its live connections, but an edge to
 * a REMOVED node still goes (no dangling), and an explicitly-requested edge is
 * always deletable regardless of endpoint lock / handling.
 * @param nodes - The nodes ReactFlow is about to delete.
 * @param edges - The edges ReactFlow is about to delete (incl. cascaded ones).
 * @param allNodes - All canvas nodes, to resolve which nodes are locked / handling.
 * @returns The subset safe to delete (protected nodes + their still-connected edges removed).
 */
export function filterGatedDeletion<
  N extends { id: string },
  E extends { id: string; source: string; target: string },
>(
  nodes: ReadonlyArray<N>,
  edges: ReadonlyArray<E>,
  allNodes: ReadonlyArray<{ id: string; type?: string; parentId?: string; data?: unknown }>,
): { nodes: N[]; edges: E[] } {
  // The delete-frozen set: everything the node-gate blocks `delete` on — locked
  // nodes (+ locked group members, the move-freeze set) plus handling nodes.
  const protectedIds = new Set<string>([
    ...lockedNodeIds(allNodes),
    ...handlingNodeIds(allNodes),
  ]);
  // Split the requested nodes into vetoed (protected → kept) vs actually removed.
  const vetoedNodeIds = new Set<string>();
  const removedNodeIds = new Set<string>();
  for (const node of nodes) {
    if (protectedIds.has(node.id)) vetoedNodeIds.add(node.id);
    else removedNodeIds.add(node.id);
  }
  return {
    nodes: nodes.filter((node) => !protectedIds.has(node.id)),
    edges: edges.filter((edge) => {
      // An endpoint is actually being removed → the edge must go with it (never
      // a dangling edge to a deleted node).
      if (removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target)) {
        return true;
      }
      // Both endpoints survive. Keep (veto) the edge ONLY when it cascaded in
      // with a vetoed node — that kept node retains its live connections. An
      // explicitly-requested edge (no vetoed endpoint) is a relation, never
      // lock- / handling-gated, so it is freely deletable.
      const touchesVetoed =
        vetoedNodeIds.has(edge.source) || vetoedNodeIds.has(edge.target);
      return !touchesVetoed;
    }),
  };
}

/**
 * Like {@link filterGatedDeletion}, but also reports whether a gate vetoed any
 * of the requested deletion, and WHICH reason, so the caller can tell the user
 * (a toast) instead of silently dropping the items. `blocked` is true when
 * fewer nodes or edges survive than were requested; `reason` is `locked` when a
 * locked NODE was vetoed (the harder freeze wins over `handling`), `handling`
 * when only handling nodes were, and null when nothing was blocked. Edges are
 * never gated on their own (they only drop out as a vetoed node's kept
 * connections), so the reason is always a node's.
 * @param nodes - The nodes ReactFlow is about to delete.
 * @param edges - The edges ReactFlow is about to delete (incl. cascaded ones).
 * @param allNodes - All canvas nodes, to resolve which nodes are locked / handling.
 * @returns The safe-to-delete subset plus a `blocked` flag and the block `reason`.
 */
export function gateBlockedDeletion<
  N extends { id: string },
  E extends { id: string; source: string; target: string },
>(
  nodes: ReadonlyArray<N>,
  edges: ReadonlyArray<E>,
  allNodes: ReadonlyArray<{ id: string; type?: string; parentId?: string; data?: unknown }>,
): {
  survivors: { nodes: N[]; edges: E[] };
  blocked: boolean;
  reason: NodeGateReason | null;
} {
  const survivors = filterGatedDeletion(nodes, edges, allNodes);
  const blocked =
    survivors.nodes.length < nodes.length ||
    survivors.edges.length < edges.length;
  let reason: NodeGateReason | null = null;
  if (blocked) {
    // `locked` is the harder freeze, so it wins when the vetoed set mixes locked
    // and handling nodes. Keyed on the vetoed NODES only — edges are never
    // lock-gated, so a kept edge is always the consequence of a vetoed node.
    const lockedIds = lockedNodeIds(allNodes);
    const lockedRemoved = nodes.some((node) => lockedIds.has(node.id));
    reason = lockedRemoved ? 'locked' : 'handling';
  }
  return { survivors, blocked, reason };
}
