// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What each external-agent canvas command does to a canvas Space document
 * (breatic#1488 §7, §8.3): the same shared writers the browser calls, gated
 * the way the browser gates the user. A node's own lock freezes it, a locked
 * Group freezes where its members are and who they are, a running task and
 * someone else's note keep a node from being deleted, and connections follow
 * the browser's rules, ids and reference-pool cap.
 */

import type * as Y from "yjs";
import type { LastView } from "@collab/services/last-view-cache.js";
import type { CanvasPerson } from "@collab/services/agent-commands/people.js";
import {
  callScopedId,
  canConnect,
  type AgentCommand,
  type AgentCommandParams,
  type AgentCommandRefusal,
  type AnnotationAssignment,
  type CanvasProposal,
} from "@breatic/shared";
import {
  HISTORY_MODALITIES,
  ROW_GAP_PX,
  addEdgeInDoc,
  addNodeInDoc,
  addReplyInDoc,
  canJoinGroup,
  canvasEdgesMap,
  canvasNodesMap,
  centerOf,
  computeDeletedAssetEntries,
  createAnnotationNode,
  createEmptyNode,
  createGroupInDoc,
  createGroupNode,
  ensureTextBodyInDoc,
  expandGroupInDoc,
  expandGroupToWrap,
  footprintOf,
  gateBlockedDeletion,
  groupEntry,
  groupRectForMembers,
  handlingNodeIds,
  lockedNodeIds,
  nodeDataMap,
  occupiedRects,
  planFlowLayout,
  planGroupAround,
  readEdges,
  readNodePlacementsInDoc,
  readNodes,
  referencePoolCount,
  removalKindOf,
  removeEdgeInDoc,
  removeElementsInDoc,
  repliesArray,
  replyIndex,
  resolveRestore,
  restoreNodeMediaInDoc,
  selectionDeletionIds,
  setNodeLockedInDoc,
  setNodeNameInDoc,
  setNodeParentInDoc,
  setNodePositionInDoc,
  shiftRightPastOccupied,
  toRelativePosition,
  unownedAnnotationIds,
  withTaskCounts,
  type AssetNodeLike,
  type HistoryModality,
  type NodePlacement,
  type Rect,
  type SpaceWriteKind,
} from "@breatic/shared/canvas-model";
import { writePlainTextIntoBody } from "@breatic/shared/canvas/text-body";
import { getCanvasReferencePoolCap, getMcpConfig } from "@breatic/core";
import type { Actor, Answer, Json } from "@collab/services/agent-commands/commands.js";
import { generationWordsOf, planGeneration } from "@collab/services/agent-commands/generation-commands.js";

/** How far inside a node's top-left corner a thread started on it puts its pin's tip. */
const PIN_INSET_PX = 16;

/** Node types without connection handles in the browser, so no edge's end. */
const UNCONNECTABLE = new Set(["group", "annotation"]);

/**
 * Refuse a command.
 * @param reason - Why.
 * @returns The answer.
 */
function refuse(reason: AgentCommandRefusal): Answer {
  return { status: "rejected", reason };
}

/**
 * Answer a command as done.
 * @param result - What it did.
 * @returns The answer.
 */
function done(result: Json): Answer {
  return { status: "done", result };
}

/**
 * The ids a create command's nodes take, derived from its call id.
 * @param command - The command.
 * @param count - How many nodes it creates.
 * @returns One id per node, in order.
 */
function createdIds(command: AgentCommand, count: number): string[] {
  return Array.from({ length: count }, (_, i) => callScopedId(command.callId, `node:${String(i)}`));
}

/**
 * The id the browser gives a connection (`onConnect`), so a second
 * connection between the same two nodes lands on the first.
 * @param source - The source node.
 * @param target - The target node.
 * @returns The edge id.
 */
export function edgeIdOf(source: string, target: string): string {
  return `${source}->${target}`;
}

/**
 * Whether adding these connections, in order, would put a node's reference
 * pool past `canvas_reference_pool_cap`, judged as the browser's `onConnect`
 * judges one: a connection already there adds nothing to the pool.
 * @param doc - The canvas document.
 * @param pairs - The connections to add.
 * @param newIds - Nodes the same write creates first, which count as sources.
 * @returns True when one of them finds its target's pool full.
 */
function poolFull(doc: Y.Doc, pairs: ReadonlyArray<{ source: string; target: string }>, newIds: readonly string[] = []): boolean {
  const cap = getCanvasReferencePoolCap();
  const nodes = [
    ...readNodes(doc).map((n) => ({ id: n.id, data: n.data as { focusImages?: unknown } })),
    ...newIds.map((id) => ({ id })),
  ];
  const edges = [...readEdges(doc)];
  for (const { source, target } of pairs) {
    const id = edgeIdOf(source, target);
    if (edges.some((e) => e.id === id)) continue;
    if (referencePoolCount(edges, nodes, target) >= cap) return true;
    edges.push({ id, source, target });
  }
  return false;
}

/**
 * A node's stored type.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns Its type, or undefined when the node is not there.
 */
export function typeOf(doc: Y.Doc, nodeId: string): string | undefined {
  const type = canvasNodesMap(doc).get(nodeId)?.get("type");
  return typeof type === "string" ? type : undefined;
}

/**
 * The Group a node belongs to.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns The Group's id, or null for a top-level node.
 */
function parentOf(doc: Y.Doc, nodeId: string): string | null {
  const parentId = canvasNodesMap(doc).get(nodeId)?.get("parentId");
  return typeof parentId === "string" ? parentId : null;
}

/**
 * Whether a node's own lock is on; readers treat only `true` as locked.
 * @param doc - The canvas document.
 * @param nodeId - The node.
 * @returns True when it is locked.
 */
export function ownLocked(doc: Y.Doc, nodeId: string): boolean {
  return nodeDataMap(doc, nodeId)?.get("locked") === true;
}

/**
 * Whether a node belongs to a locked Group, which freezes its position and membership.
 * @param doc - The canvas document.
 * @param parentId - The Group, or null.
 * @returns True when that Group is there and locked.
 */
function lockedGroup(doc: Y.Doc, parentId: string | null): boolean {
  return parentId !== null && groupEntry(doc, parentId)?.data.get("locked") === true;
}

/**
 * Every node's absolute rect, by id, sized as placement sizes a node nobody has measured.
 * @param doc - The canvas document.
 * @returns The rects.
 */
function rectsById(doc: Y.Doc): Map<string, Rect> {
  return new Map(readNodePlacementsInDoc(doc).map((p: NodePlacement) => [p.id, { x: p.x, y: p.y, ...footprintOf(p, () => undefined) }]));
}

/**
 * Grow a Group so it still wraps every member, as the browser does after a
 * member is dropped into or moved inside it; never shrinks it.
 * @param doc - The canvas document.
 * @param groupId - The Group.
 */
function growToWrap(doc: Y.Doc, groupId: string): void {
  const rects = rectsById(doc);
  const group = rects.get(groupId);
  if (!group) return;
  const members: Rect[] = [];
  canvasNodesMap(doc).forEach((node, id) => {
    const rect = rects.get(id);
    if (node.get("parentId") === groupId && rect) members.push(rect);
  });
  const grown = expandGroupToWrap(group, members);
  if (grown.x === group.x && grown.y === group.y && grown.width === group.width && grown.height === group.height) return;
  expandGroupInDoc(doc, groupId, { x: grown.x, y: grown.y }, grown.width, grown.height);
}

/**
 * What new nodes are aimed at when the agent names no place (§8.2): the
 * centre of the rectangle the user is looking at on this canvas, else their
 * pointer, else the centre of what the canvas holds, or the origin on an
 * empty canvas; and what they must not cover.
 * @param doc - The canvas document.
 * @param view - What the user has on screen on this canvas, when they are on it.
 * @returns The point aimed at and every node's footprint.
 */
export function newNodesAim(doc: Y.Doc, view?: LastView): { centre: { x: number; y: number }; occupied: Rect[] } {
  const occupied = occupiedRects(readNodePlacementsInDoc(doc), () => undefined);
  if (view?.camera) return { centre: centerOf(view.camera), occupied };
  if (view?.pointer) return { centre: view.pointer, occupied };
  const all = groupRectForMembers(occupied, 0);
  return { centre: all ? centerOf(all) : { x: 0, y: 0 }, occupied };
}

/**
 * Where new nodes go when the agent names no place (§8.2): aimed as
 * `newNodesAim` says, laid out as the browser lays out a placed batch, then
 * moved right until it covers nothing.
 * @param doc - The canvas document.
 * @param nodes - The nodes to place.
 * @param edges - Edges between them, by index into `nodes`.
 * @param view - What the user has on screen on this canvas.
 * @returns One top-left position per node.
 */
function placeNewNodes(
  doc: Y.Doc,
  nodes: AgentCommandParams<"create_canvas_nodes">["nodes"],
  edges: CanvasProposal["edges"],
  view: LastView | undefined,
): Array<{ x: number; y: number }> {
  const { centre, occupied } = newNodesAim(doc, view);
  const proposal: CanvasProposal = {
    nodes: nodes.map((node) => ({ role: "source", type: node.type, name: node.name ?? "" })),
    edges,
    rationale: "",
  };
  const aimed = planFlowLayout(proposal, centre);
  const searched = groupRectForMembers(aimed.map(withTaskCounts), 0);
  const dx = searched ? shiftRightPastOccupied(searched, occupied, ROW_GAP_PX) : 0;
  return aimed.map((spot) => ({ x: spot.x + dx, y: spot.y }));
}

/**
 * Why an edge between two node types cannot be drawn, as the browser's
 * connection check decides: a self-loop, an end without handles, or a pair
 * `canConnect` forbids.
 * @param sourceId - The source node.
 * @param sourceType - Its type.
 * @param targetId - The target node.
 * @param targetType - Its type.
 * @returns True when the edge may be drawn.
 */
export function connectable(sourceId: string, sourceType: string, targetId: string, targetType: string): boolean {
  if (sourceId === targetId) return false;
  if (UNCONNECTABLE.has(sourceType) || UNCONNECTABLE.has(targetType)) return false;
  return canConnect(sourceType, targetType);
}

/**
 * The source and target ids of a create command's edges.
 * @param params - The command's parameters.
 * @param ids - The ids its nodes take.
 * @returns One pair per edge, in order.
 */
function createdPairs(params: AgentCommandParams<"create_canvas_nodes">, ids: readonly string[]): Array<{ source: string; target: string }> {
  /**
   * One end's node id.
   * @param end - The end as the agent named it.
   * @returns The node id.
   */
  const idOf = (end: { new: number } | { id: string }): string => ("new" in end ? ids[end.new]! : end.id);
  return (params.edges ?? []).map((edge) => ({ source: idOf(edge.source), target: idOf(edge.target) }));
}

/**
 * What a create command made, once it is in the document.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The result, or null when not all of it is there.
 */
function createdResult(doc: Y.Doc, params: AgentCommandParams<"create_canvas_nodes">, command: AgentCommand): Json | null {
  const nodesMap = canvasNodesMap(doc);
  const nodeIds = createdIds(command, params.nodes.length);
  const groupId = params.group ? callScopedId(command.callId, "group") : undefined;
  if (!nodeIds.every((id) => nodesMap.has(id)) || (groupId && !nodesMap.has(groupId))) return null;
  return {
    nodeIds,
    ...(params.edges ? { edgeIds: createdPairs(params, nodeIds).map((p) => edgeIdOf(p.source, p.target)) } : {}),
    ...(groupId ? { groupId } : {}),
  };
}

/**
 * A create command's answer once its deadline has passed: done when an
 * earlier delivery wrote all of it.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function createLate(doc: Y.Doc, params: AgentCommandParams<"create_canvas_nodes">, command: AgentCommand): Answer {
  const result = createdResult(doc, params, command);
  return result === null ? { status: "unfinished" } : done(result);
}

/**
 * Create nodes, the edges among them and to existing nodes, and a Group
 * around them. Everything is judged before anything is written.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @param view - What the user has on screen on this canvas, when they are on it.
 * @returns The answer.
 */
export function createNodes(doc: Y.Doc, params: AgentCommandParams<"create_canvas_nodes">, command: AgentCommand, view?: LastView): Answer {
  const { nodes, edges = [], group } = params;
  const ids = createdIds(command, nodes.length);
  const nodesMap = canvasNodesMap(doc);
  /**
   * One end of an edge, as a node id and type.
   * @param end - The end as the agent named it.
   * @returns Its id and type; the type is undefined when the node is not there.
   */
  const resolve = (end: { new: number } | { id: string }): { id: string; type: string | undefined } =>
    "new" in end ? { id: ids[end.new]!, type: nodes[end.new]!.type } : { id: end.id, type: typeOf(doc, end.id) };
  const ends = edges.map((edge) => ({ source: resolve(edge.source), target: resolve(edge.target) }));
  if (ends.some((e) => e.source.type === undefined || e.target.type === undefined)) return refuse("not_found");
  if (ends.some((e) => !connectable(e.source.id, e.source.type!, e.target.id, e.target.type!))) return refuse("cannot_connect");
  const pairs = createdPairs(params, ids);
  if (poolFull(doc, pairs, ids)) return refuse("reference_pool_full");
  const include = group?.include ?? [];
  for (const id of include) {
    const type = typeOf(doc, id);
    if (type === undefined) return refuse("not_found");
    if (!canJoinGroup(type)) return refuse("invalid_command");
    if (ownLocked(doc, id) || lockedGroup(doc, parentOf(doc, id))) return refuse("locked");
  }

  // A node already there was written by an earlier delivery of this call;
  // writing it again would replace it with an empty one.
  const missing = nodes.flatMap((node, i) => (nodesMap.has(ids[i]!) ? [] : [{ node, id: ids[i]!, index: i }]));
  const unplaced = missing.filter((m) => m.node.position === undefined);
  const slotOf = new Map(unplaced.map((m, slot) => [m.index, slot]));
  const flowEdges = edges.flatMap((edge) => {
    if (!("new" in edge.source) || !("new" in edge.target)) return [];
    const fromIndex = slotOf.get(edge.source.new);
    const toIndex = slotOf.get(edge.target.new);
    return fromIndex === undefined || toIndex === undefined ? [] : [{ fromIndex, toIndex }];
  });
  const spots = placeNewNodes(doc, unplaced.map((m) => m.node), flowEdges, view);
  for (const { node, id, index } of missing) {
    const empty = createEmptyNode(node.type, node.position ?? spots[slotOf.get(index)!]!, command.userId);
    addNodeInDoc(doc, {
      ...empty,
      id,
      data: { ...empty.data, ...(node.name !== undefined ? { name: node.name } : {}) },
    });
  }
  // An edge already there keeps its first stamp (`putEdge`).
  for (const { source, target } of pairs) addEdgeInDoc(doc, { id: edgeIdOf(source, target), source, target });
  const groupId = callScopedId(command.callId, "group");
  if (group && !nodesMap.has(groupId)) {
    const rects = rectsById(doc);
    const members = [...ids, ...include].flatMap((id) => {
      const rect = rects.get(id);
      return rect ? [{ id, type: typeOf(doc, id), position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height }] : [];
    });
    const plan = planGroupAround(members, groupId);
    if (plan) {
      createGroupInDoc(
        doc,
        createGroupNode(groupId, plan.position, plan.width, plan.height, command.userId, undefined, group.name),
        plan.members,
      );
    }
  }
  return done(createdResult(doc, params, command));
}

/**
 * Change a node's name, place, Group, words or generation settings, gated as
 * the browser gates a user: its own lock freezes every change, and a locked
 * Group freezes where its members are and who they are. Nothing is written
 * unless every part may be.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @returns The answer.
 */
export function updateNode(doc: Y.Doc, params: AgentCommandParams<"update_canvas_node">): Answer {
  const { nodeId, name, position, parentId, text, generation } = params;
  const type = typeOf(doc, nodeId);
  if (type === undefined || nodeDataMap(doc, nodeId) === null) return refuse("not_found");
  if (text !== undefined && type !== "text") return refuse("invalid_command");
  const current = parentOf(doc, nodeId);
  const reparent = parentId !== undefined && parentId !== current;
  if (reparent && parentId !== null) {
    if (!canvasNodesMap(doc).has(parentId)) return refuse("not_found");
    if (typeOf(doc, parentId) !== "group" || !canJoinGroup(type)) return refuse("invalid_command");
  }
  if (ownLocked(doc, nodeId)) return refuse("locked");
  if (reparent && (lockedGroup(doc, current) || lockedGroup(doc, parentId))) return refuse("locked");
  if (!reparent && position !== undefined && lockedGroup(doc, current)) return refuse("locked");
  const writeGeneration = generation === undefined ? undefined : planGeneration(doc, nodeId, type, generation);
  if (typeof writeGeneration === "object") return writeGeneration;

  if (name !== undefined) setNodeNameInDoc(doc, nodeId, name);
  if (text !== undefined) writePlainTextIntoBody(ensureTextBodyInDoc(doc, nodeId)!, text);
  if (reparent) {
    // Without a position the node stays where it is on the canvas; a given
    // position is measured against the Group it joins.
    const rects = rectsById(doc);
    const at = rects.get(nodeId) ?? { x: 0, y: 0 };
    const groupAt = parentId === null ? undefined : rects.get(parentId);
    const next = position ?? (groupAt ? toRelativePosition(at, groupAt) : { x: at.x, y: at.y });
    setNodeParentInDoc(doc, nodeId, parentId, next);
  } else if (position !== undefined) {
    setNodePositionInDoc(doc, nodeId, position, current);
  }
  const finalParent = reparent ? parentId : current;
  if (finalParent !== null && (reparent || position !== undefined)) growToWrap(doc, finalParent);
  writeGeneration?.();
  return done({ nodeId });
}

/**
 * Delete nodes as the browser deletes a selection: a Group takes its members
 * with it, every edge touching a deleted node goes, and a locked node, a node
 * with a running task and a note someone else wrote are kept.
 * @param doc - The canvas document.
 * @param nodeIds - The nodes to delete.
 * @param command - The command.
 * @param actor - Who deletes.
 * @returns The answer.
 */
export function deleteNodes(doc: Y.Doc, nodeIds: string[], command: AgentCommand, actor: Actor): Answer {
  const all = readNodes(doc);
  const present = new Set(all.map((n) => n.id));
  if (nodeIds.some((id) => !present.has(id))) return refuse("not_found");
  const ids = selectionDeletionIds(nodeIds, all);
  const targets = all.filter((n) => ids.has(n.id));
  const edges = readEdges(doc).filter((e) => ids.has(e.source) || ids.has(e.target));
  const viewer = { userId: command.userId, role: actor.role };
  const { survivors } = gateBlockedDeletion(targets, edges, all, viewer);
  removeElementsInDoc(doc, survivors.nodes.map((n) => n.id), survivors.edges.map((e) => e.id));

  // Same order as `gateBlockedDeletion`'s reason: the lock first, authorship
  // over a running task. A Group kept only because a member is kept takes
  // that member's reason.
  const locked = lockedNodeIds(all);
  const unowned = unownedAnnotationIds(all, viewer);
  const handling = handlingNodeIds(all);
  /**
   * Why one kept node was kept.
   * @param id - The node.
   * @returns The reason, or null when none of the gates holds it.
   */
  const ownReason = (id: string): "locked" | "not_yours" | "handling" | null =>
    locked.has(id) ? "locked" : unowned.has(id) ? "not_yours" : handling.has(id) ? "handling" : null;
  const order = ["locked", "not_yours", "handling"] as const;
  const deleted = new Set(survivors.nodes.map((n) => n.id));
  const kept = targets
    .filter((n) => !deleted.has(n.id))
    .map((n) => {
      const memberReasons = all.filter((m) => m.parentId === n.id).map((m) => ownReason(m.id));
      const reason = ownReason(n.id) ?? order.find((r) => memberReasons.includes(r)) ?? "locked";
      return { nodeId: n.id, reason };
    });
  const deletedAssets = computeDeletedAssetEntries(
    survivors.nodes.map((n) => ({ id: n.id, type: n.type, data: n.data as AssetNodeLike["data"] })),
    all.map((n) => ({ id: n.id, type: n.type, data: n.data as AssetNodeLike["data"] })),
    command.spaceId!,
  );
  return done({ deleted: [...deleted], kept, deletedAssets: deletedAssets as unknown as Json });
}

/**
 * Lock or unlock nodes; any id not on the canvas changes none of them.
 * @param doc - The canvas document.
 * @param nodeIds - The nodes.
 * @param locked - The new lock state.
 * @returns The answer.
 */
export function setLocked(doc: Y.Doc, nodeIds: string[], locked: boolean): Answer {
  if (nodeIds.some((id) => nodeDataMap(doc, id) === null)) return refuse("not_found");
  for (const id of nodeIds) setNodeLockedInDoc(doc, id, locked);
  return done({ nodeIds });
}

/**
 * Start a thread, or reply to one, as the user.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @param command - The command.
 * @returns The answer.
 */
export function comment(doc: Y.Doc, params: AgentCommandParams<"comment_on_canvas">, command: AgentCommand): Answer {
  const { text, position, nodeId, annotationId } = params;
  if (annotationId !== undefined) {
    const type = typeOf(doc, annotationId);
    if (type === undefined) return refuse("not_found");
    const replies = repliesArray(doc, annotationId);
    if (type !== "annotation" || !replies) return refuse("invalid_command");
    const replyId = callScopedId(command.callId, "reply");
    // Collaborative data: read as untrusted.
    const assignment = nodeDataMap(doc, annotationId)?.get("assignment") as Partial<AnnotationAssignment> | undefined;
    const answers =
      assignment?.connectionId === command.connectionId && typeof assignment.assignedAt === "number"
        ? assignment.assignedAt
        : undefined;
    const answered = answers !== undefined;
    if (replyIndex(replies, replyId) === -1) {
      addReplyInDoc(doc, annotationId, {
        id: replyId,
        content: text,
        createdBy: command.userId,
        createdAt: Date.now(),
        via: command.connectionId,
        ...(answered ? { answers } : {}),
      });
    }
    return done({ replyId, answered });
  }
  let tip = position;
  if (nodeId !== undefined) {
    const at = rectsById(doc).get(nodeId);
    if (!at) return refuse("not_found");
    tip = { x: at.x + PIN_INSET_PX, y: at.y + PIN_INSET_PX };
  }
  const id = callScopedId(command.callId, "annotation");
  if (!canvasNodesMap(doc).has(id)) addNodeInDoc(doc, { ...createAnnotationNode(tip!, command.userId, text), id });
  return done({ annotationId: id });
}

/**
 * The size kind a deletion is judged by, as the browser's `removeElements`
 * judges it: a pure removal, or a compound one when a deleted Group releases
 * members that stay.
 * @param doc - The canvas document.
 * @param nodeIds - The nodes to delete.
 * @returns The kind.
 */
export function deletionKind(doc: Y.Doc, nodeIds: string[]): SpaceWriteKind {
  return removalKindOf(canvasNodesMap(doc), selectionDeletionIds(nodeIds, readNodes(doc)));
}

/**
 * Connect nodes as the browser's `onConnect` does: the browser's edge id,
 * its connection rules, and its reference-pool cap. Nothing is written when
 * any of them is refused.
 * @param doc - The canvas document.
 * @param edges - The connections.
 * @returns The answer.
 */
export function connectNodes(doc: Y.Doc, edges: ReadonlyArray<{ source: string; target: string }>): Answer {
  const typed = edges.map((e) => ({ ...e, sourceType: typeOf(doc, e.source), targetType: typeOf(doc, e.target) }));
  if (typed.some((e) => e.sourceType === undefined || e.targetType === undefined)) return refuse("not_found");
  if (typed.some((e) => !connectable(e.source, e.sourceType!, e.target, e.targetType!))) return refuse("cannot_connect");
  if (poolFull(doc, edges)) return refuse("reference_pool_full");
  for (const { source, target } of edges) addEdgeInDoc(doc, { id: edgeIdOf(source, target), source, target });
  return done({ edgeIds: edges.map((e) => edgeIdOf(e.source, e.target)) });
}

/**
 * Remove connections; any id not on the canvas removes none of them.
 * @param doc - The canvas document.
 * @param ids - The edge ids.
 * @returns The answer.
 */
export function disconnectNodes(doc: Y.Doc, ids: string[]): Answer {
  const edgesMap = canvasEdgesMap(doc);
  if (ids.some((id) => !edgesMap.has(id))) return refuse("not_found");
  for (const id of ids) removeEdgeInDoc(doc, id);
  return done({ edgeIds: ids });
}

/**
 * Read the canvas: the named nodes, or at most `read_canvas_max_nodes` of
 * all of them, with the edges that touch what is returned.
 * @param doc - The canvas document.
 * @param nodeIds - The nodes to read; all of them when absent.
 * @param people - Who is on this canvas now.
 * @returns The answer.
 */
export function readCanvas(doc: Y.Doc, nodeIds: string[] | undefined, people: CanvasPerson[]): Answer {
  const wanted = nodeIds ? new Set(nodeIds) : null;
  const all = readNodes(doc).filter((node) => !wanted || wanted.has(node.id));
  const nodes = (wanted ? all : all.slice(0, getMcpConfig().read_canvas_max_nodes)).map((node) => ({
    ...node,
    ...generationWordsOf(doc, node.id),
  }));
  const kept = new Set(nodes.map((node) => node.id));
  const edges = readEdges(doc).filter((edge) => kept.has(edge.source) || kept.has(edge.target));
  const cut = nodes.length < all.length ? { truncated: true, total: all.length } : {};
  // The views hold no value JSON cannot carry except `undefined`, which
  // the round trip drops.
  return done(JSON.parse(JSON.stringify({ nodes, edges, ...cut, people })) as Json);
}

/**
 * Put a past result back on a node, as the history panel's restore does.
 * @param doc - The canvas document.
 * @param params - The command's parameters.
 * @returns The answer.
 */
export function restore(doc: Y.Doc, params: AgentCommandParams<"restore_node_version">): Answer {
  const { nodeId, entry } = params;
  const type = typeOf(doc, nodeId);
  if (type === undefined) return refuse("not_found");
  if (!HISTORY_MODALITIES.has(type)) return refuse("invalid_command");
  const decision = resolveRestore({
    readOnly: false,
    entry,
    modality: type as HistoryModality,
    gateState: { locked: ownLocked(doc, nodeId) },
  });
  if (decision.kind === "blocked") return refuse("locked");
  if (decision.kind === "noop") return refuse("invalid_command");
  restoreNodeMediaInDoc(doc, nodeId, { content: decision.content, media: decision.media });
  return done({ nodeId });
}

