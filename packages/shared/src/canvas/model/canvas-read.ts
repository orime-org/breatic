// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a canvas Space document: the node and edge maps, a node's nested
 * `data` map, an annotation's replies, and the render-ready views web draws
 * (breatic#1488 §8.1). Pure functions of a `Y.Doc`, so collab reads the
 * document exactly the way the browser does.
 *
 * Wire layout: a top-level `Y.Map("nodesMap")` of node `Y.Map`s, each
 * `{ id, type, position, parentId?, data }` where `data` is itself a `Y.Map`,
 * and a top-level `Y.Map("edgesMap")` of edge `Y.Map`s.
 */

import * as Y from 'yjs';

import { CANVAS_NODES_KEY, type CanvasNodeFields, type NodeType } from '@shared/types/canvas-node.js';
import { toNodeView, type CanvasEdge, type TypedNodeView } from '@shared/canvas/model/node-view.js';
import type { NodePlacement } from '@shared/canvas/model/place-flow.js';
import { bodyToPlainText } from '@shared/canvas/text-body.js';

/** The top-level map of a canvas document's edges. */
export const CANVAS_EDGES_KEY = 'edgesMap';

/**
 * A render-ready canvas node: identity, position, and its type paired with the
 * view of that type. `type` is the stored node type and doubles as the
 * ReactFlow node type (the `NODE_TYPES` registry key); checking it narrows
 * `data`.
 */
export type CanvasNodeView = TypedNodeView & {
  id: string;
  position: { x: number; y: number };
  /**
   * Containing Group id (group redesign 2026-06-23) — present on a member
   * node so `toFlowNode` can hand ReactFlow a parented node. Absent for
   * top-level nodes.
   */
  parentId?: string;
};

/**
 * A canvas document's node map.
 * @param doc - The canvas-space document.
 * @returns Its `nodesMap`.
 */
export function canvasNodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY);
}

/**
 * A canvas document's edge map.
 * @param doc - The canvas-space document.
 * @returns Its `edgesMap`.
 */
export function canvasEdgesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(CANVAS_EDGES_KEY);
}

/**
 * A node's nested `data` map, or `null` when the node is gone or malformed.
 *
 * Every fragment hanging off a node (the text body, the generation prompt) has
 * to walk this path first, so it lives in one place.
 * @param doc - The canvas-space document.
 * @param nodeId - Id of the node to look up.
 * @returns The node's data map, or `null`.
 */
export function nodeDataMap(doc: Y.Doc, nodeId: string): Y.Map<unknown> | null {
  const node = canvasNodesMap(doc).get(nodeId);
  if (!node) return null;
  const data = node.get('data');
  return data instanceof Y.Map ? data : null;
}

/**
 * A Group node and its data map, or `null` when the id names no Group with one.
 * @param doc - The canvas-space document.
 * @param groupId - Id of the Group.
 * @returns The Group's map and its data map, or `null`.
 */
export function groupEntry(doc: Y.Doc, groupId: string): { group: Y.Map<unknown>; data: Y.Map<unknown> } | null {
  const group = canvasNodesMap(doc).get(groupId);
  if (!(group instanceof Y.Map) || group.get('type') !== 'group') return null;
  const data = group.get('data');
  return data instanceof Y.Map ? { group, data } : null;
}

/**
 * An annotation's replies sequence.
 *
 * The `Y.Array` check narrows what the document hands back rather than
 * allowing for a sticky without a container: every sticky is born holding one
 * (`buildDataMap`) and nothing removes it.
 * @param doc - The canvas-space document.
 * @param nodeId - Id of the annotation node.
 * @returns The sequence, or `null` when the node is gone.
 */
export function repliesArray(doc: Y.Doc, nodeId: string): Y.Array<Y.Map<unknown>> | null {
  const replies = nodeDataMap(doc, nodeId)?.get('replies');
  return replies instanceof Y.Array ? (replies as Y.Array<Y.Map<unknown>>) : null;
}

/**
 * Index of the reply with this id.
 * @param replies - The annotation's replies sequence.
 * @param replyId - Id of the reply to find.
 * @returns Its position, or `-1` when no reply carries that id.
 */
export function replyIndex(replies: Y.Array<Y.Map<unknown>>, replyId: string): number {
  return replies.toArray().findIndex((reply) => reply.get('id') === replyId);
}

/**
 * The map an annotation edit writes: the annotation's data, or one reply.
 * @param doc - The canvas document.
 * @param nodeId - Id of the annotation.
 * @param replyId - The reply, or null for the body.
 * @returns The map, or null when it is gone.
 */
export function annotationEditTarget(doc: Y.Doc, nodeId: string, replyId: string | null): Y.Map<unknown> | null {
  if (replyId === null) return nodeDataMap(doc, nodeId);
  const replies = repliesArray(doc, nodeId);
  if (!replies) return null;
  const index = replyIndex(replies, replyId);
  return index === -1 ? null : replies.get(index);
}

/**
 * What deleting these nodes produces (design 5.2): `compound` when a Group
 * goes while one of its members stays, since that member is rewritten to
 * stand on its own; otherwise `remove`.
 * @param nodesMap - The canvas-space `nodesMap`.
 * @param deleted - The nodes being deleted.
 * @returns The kind.
 */
export function removalKindOf(nodesMap: Y.Map<Y.Map<unknown>>, deleted: ReadonlySet<string>): 'remove' | 'compound' {
  let kind: 'remove' | 'compound' = 'remove';
  nodesMap.forEach((node, id) => {
    const parentId = node instanceof Y.Map ? node.get('parentId') : undefined;
    if (typeof parentId === 'string' && deleted.has(parentId) && !deleted.has(id)) kind = 'compound';
  });
  return kind;
}

/**
 * Read all nodes from `nodesMap` into render-ready views. Each node's wire
 * fields are projected through `toNodeView`; nodes with a dirty / unknown
 * `type` or a missing `data` Y.Map are skipped.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current renderable canvas nodes.
 */
export function readNodes(doc: Y.Doc): ReadonlyArray<CanvasNodeView> {
  const nodesMap = canvasNodesMap(doc);
  const out: CanvasNodeView[] = [];
  nodesMap.forEach((nodeMap) => {
    if (!(nodeMap instanceof Y.Map)) return;
    const dataMap = nodeMap.get('data');
    if (!(dataMap instanceof Y.Map)) return;
    const fields: CanvasNodeFields = {
      id: String(nodeMap.get('id') ?? ''),
      type: nodeMap.get('type') as NodeType,
      position: (nodeMap.get('position') as { x: number; y: number }) ?? {
        x: 0,
        y: 0,
      },
      data: dataMap.toJSON() as CanvasNodeFields['data'],
    };
    const typed = toNodeView(fields);
    if (!typed) return;
    const parentId = nodeMap.get('parentId');
    out.push({
      id: fields.id,
      ...typed,
      position: fields.position,
      ...(typeof parentId === 'string' ? { parentId } : {}),
    });
  });
  return out;
}

/**
 * Read all edges from `edgesMap` into a ReactFlow-ready array.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current canvas edges, with defaults applied for missing fields.
 */
export function readEdges(doc: Y.Doc): ReadonlyArray<CanvasEdge> {
  const edgesMap = canvasEdgesMap(doc);
  const out: CanvasEdge[] = [];
  edgesMap.forEach((map) => {
    if (!(map instanceof Y.Map)) return;
    // createdAt is untrusted collaborative data (same convention as
    // the untrusted-Yjs convention): a corrupt stamp (string / NaN) would make the rail
    // sort comparator return NaN, which TimSort treats as "equal" — silently
    // un-sorting HEALTHY edges around it. Drop anything non-finite.
    const rawCreatedAt = map.get('createdAt');
    out.push({
      id: String(map.get('id') ?? ''),
      source: String(map.get('source') ?? ''),
      target: String(map.get('target') ?? ''),
      toolId: (map.get('toolId') as string | undefined) ?? undefined,
      createdAt:
        typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt)
          ? rawCreatedAt
          : undefined,
    });
  });
  return out;
}

/**
 * Where every node of a canvas document sits, with the facts its size follows from.
 *
 * Read from the document, so a node written a moment ago counts before it has
 * rendered. A Group member's stored position is relative to its Group, so its
 * Group's position is added.
 * @param doc - The canvas-space document.
 * @returns One placement per node, in no particular order.
 */
export function readNodePlacementsInDoc(doc: Y.Doc): NodePlacement[] {
  const nodesMap = canvasNodesMap(doc);
  /**
   * A node's stored position.
   * @param node - The node's map, if any.
   * @returns Its position, or undefined when it has none.
   */
  const positionOf = (node: unknown): { x: number; y: number } | undefined =>
    node instanceof Y.Map ? (node.get('position') as { x: number; y: number } | undefined) : undefined;
  /**
   * A number the node's data holds under this key.
   * @param data - The node's data map, if any.
   * @param key - The key.
   * @returns The number, or undefined.
   */
  const numberIn = (data: unknown, key: string): number | undefined => {
    const value = data instanceof Y.Map ? data.get(key) : undefined;
    return typeof value === 'number' ? value : undefined;
  };
  const out: NodePlacement[] = [];
  nodesMap.forEach((node, id) => {
    const at = positionOf(node);
    if (at === undefined) return;
    const parentId = node.get('parentId');
    const parent = typeof parentId === 'string' ? positionOf(nodesMap.get(parentId)) : undefined;
    const data = node.get('data');
    const body = data instanceof Y.Map ? data.get('body') : undefined;
    out.push({
      id,
      type: String(node.get('type')),
      x: parent === undefined ? at.x : at.x + parent.x,
      y: parent === undefined ? at.y : at.y + parent.y,
      width: numberIn(data, 'width'),
      height: numberIn(data, 'height'),
      mediaWidth: numberIn(data, 'mediaWidth'),
      mediaHeight: numberIn(data, 'mediaHeight'),
      bodyText: body instanceof Y.XmlFragment ? bodyToPlainText(body) : undefined,
    });
  });
  return out;
}
