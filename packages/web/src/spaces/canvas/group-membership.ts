// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure node-state set logic for the canvas: which nodes a lock or an in-flight
 * task freezes. A LOCK freezes a locked node or a member of a locked Group
 * (membership via `parentId`, group redesign 2026-06-23) against every mutation;
 * HANDLING freezes a node with a running task against deletion (and the other
 * content-affecting ops) but not against move / rename. The per-op decision
 * lives in {@link ./node-gate}; these helpers materialize the frozen SETS the
 * canvas wires into `renderNodes` (draggable, lock-only) and the delete guards.
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
 * `draggable=false`) nor deleted ({@link filterLockedDeletion}); both reuse this
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
 * (a locked group OR a locked standalone node), a locked group's members, any
 * node currently `handling` a task, AND every edge touching a protected node
 * are kept OUT of the deletion. Wire into ReactFlow's `onBeforeDelete` (the
 * pre-delete veto) — the post-hoc `onDelete` can't stop ReactFlow from removing
 * nodes/edges from the local buffer first, nor from cascading a protected node's
 * edges into the deletion (edges are part of the frozen structure too).
 * @param nodes - The nodes ReactFlow is about to delete.
 * @param edges - The edges ReactFlow is about to delete (incl. cascaded ones).
 * @param allNodes - All canvas nodes, to resolve which nodes are locked / handling.
 * @returns The subset safe to delete (protected nodes + their edges removed).
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
  return {
    nodes: nodes.filter((node) => !protectedIds.has(node.id)),
    edges: edges.filter(
      (edge) =>
        !protectedIds.has(edge.source) && !protectedIds.has(edge.target),
    ),
  };
}

/**
 * Like {@link filterGatedDeletion}, but also reports whether a gate vetoed any
 * of the requested deletion, and WHICH reason, so the caller can tell the user
 * (a toast) instead of silently dropping the items. `blocked` is true when
 * fewer nodes or edges survive than were requested; `reason` is `locked` when a
 * locked node/edge was vetoed (the harder freeze wins over `handling`),
 * `handling` when only handling nodes were, and null when nothing was blocked.
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
    // and handling nodes: a node/edge removed because a LOCKED node protects it
    // reports `locked`; only handling nodes removed reports `handling`.
    const lockedIds = lockedNodeIds(allNodes);
    const lockedRemoved =
      nodes.some((node) => lockedIds.has(node.id)) ||
      edges.some(
        (edge) => lockedIds.has(edge.source) || lockedIds.has(edge.target),
      );
    reason = lockedRemoved ? 'locked' : 'handling';
  }
  return { survivors, blocked, reason };
}
