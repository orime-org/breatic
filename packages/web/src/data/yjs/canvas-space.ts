// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import type { CanvasNodeFields, NodeType } from '@breatic/shared';

import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';
import type { NodeKind, NodeView } from '@web/spaces/canvas/types/node-view';
import { toNodeView } from '@web/spaces/canvas/types/node-view';

/**
 * Canvas-space Yjs document — single source of truth for one canvas
 * space's nodes + edges.
 *
 * Wire layout (aligned with the backend — see collab `task-listener.ts`
 * and the shared `CanvasNodeFields` contract):
 *   - top-level `Y.Map("nodesMap")` of node `Y.Map`s. Each node Y.Map has
 *     `{ id, type, position, data }` where **`data` is itself a Y.Map**
 *     holding the `CanvasNodeFields['data']` fields.
 *   - top-level `Y.Map("edgesMap")` of edge `Y.Map`s.
 *
 * The nested `data` Y.Map is load-bearing: collab's task-listener reaches
 * `nodesMap.get(nodeId).get("data")` and asserts `instanceof Y.Map` before
 * writing the worker's result back. A plain object there (the pre-#1269
 * frontend bug) is silently skipped, so results never reach the canvas.
 *
 * Frontend owns node create / delete / position + edges. Backend (Worker
 * via Collab) only sets state fields inside the node's `data` Y.Map.
 *
 * Read side projects each wire node through `toNodeView`, returning
 * ReactFlow-ready `CanvasNodeView`s (only nodes with a dirty / unknown
 * `type` or a missing `data` Y.Map are skipped).
 */

/** A render-ready canvas node: identity + position + the narrowed view. */
export interface CanvasNodeView {
  id: string;
  /** ReactFlow node type = the view kind (the `NODE_TYPES` registry key). */
  type: NodeKind;
  position: { x: number; y: number };
  data: NodeView;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: 'primary' | 'reference';
  toolId?: string;
}

interface CanvasSpaceState {
  nodes: ReadonlyArray<CanvasNodeView>;
  edges: ReadonlyArray<CanvasEdge>;
  synced: boolean;
}

const NODES_KEY = 'nodesMap';
const EDGES_KEY = 'edgesMap';

/**
 * Subscribe to a canvas-space document.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space whose nodes and edges to observe.
 * @returns The current nodes, edges, and whether the doc has synced with the server.
 */
export function useCanvasSpace(
  projectId: string,
  spaceId: string,
): CanvasSpaceState {
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = React.useMemo(() => getDoc(name), [name]);
  const { synced } = useSocket({ name, doc });
  const [nodes, setNodes] = React.useState<ReadonlyArray<CanvasNodeView>>(() =>
    readNodes(doc),
  );
  const [edges, setEdges] = React.useState<ReadonlyArray<CanvasEdge>>(() =>
    readEdges(doc),
  );

  React.useEffect(() => {
    const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
    const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
    /**
     * Re-read all nodes from the doc into React state.
     * @returns Nothing.
     */
    const updateNodes = (): void => setNodes(readNodes(doc));
    /**
     * Re-read all edges from the doc into React state.
     * @returns Nothing.
     */
    const updateEdges = (): void => setEdges(readEdges(doc));
    nodesMap.observeDeep(updateNodes);
    edgesMap.observeDeep(updateEdges);
    updateNodes();
    updateEdges();
    return () => {
      nodesMap.unobserveDeep(updateNodes);
      edgesMap.unobserveDeep(updateEdges);
    };
  }, [doc]);

  return { nodes, edges, synced };
}

/**
 * Build the nested `data` Y.Map for a node from a plain wire data object.
 * Each defined field becomes a Y.Map entry (plain values — strings,
 * numbers, booleans, plain arrays / objects — matching how the backend
 * reads `operationLocks` via `Array.isArray` and `handlingBy` as a plain
 * object). Undefined fields are omitted.
 * @param data - The plain wire data fields to write.
 * @returns A Y.Map populated with the defined data fields.
 */
function buildDataMap(data: CanvasNodeFields['data']): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) map.set(key, value);
  }
  return map;
}

/**
 * Add a node — frontend-owned operation. Stores the wire `CanvasNodeFields`
 * shape (a node Y.Map with a nested `data` Y.Map) under `nodesMap`.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the node to.
 * @param node - The wire node fields (id, type, position, data) to insert.
 */
export function addNode(
  projectId: string,
  spaceId: string,
  node: CanvasNodeFields,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', node.id);
    map.set('type', node.type);
    map.set('position', node.position);
    map.set('data', buildDataMap(node.data));
    nodesMap.set(node.id, map);
  });
}

/**
 * Delete a node by id — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to remove the node from.
 * @param nodeId - Id of the node to delete.
 */
export function removeNode(
  projectId: string,
  spaceId: string,
  nodeId: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    nodesMap.delete(nodeId);
  });
}

/**
 * Update node position (drag end) — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to reposition.
 * @param position - The node's new canvas coordinates.
 * @param position.x - New x coordinate.
 * @param position.y - New y coordinate.
 */
export function setNodePosition(
  projectId: string,
  spaceId: string,
  nodeId: string,
  position: { x: number; y: number },
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  node.set('position', position);
}

/**
 * Add an edge (e.g. mini-tool primary edge).
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the edge to.
 * @param edge - The edge to insert (id, source, target, kind, optional toolId).
 */
export function addEdge(
  projectId: string,
  spaceId: string,
  edge: CanvasEdge,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', edge.id);
    map.set('source', edge.source);
    map.set('target', edge.target);
    map.set('kind', edge.kind);
    if (edge.toolId) map.set('toolId', edge.toolId);
    edgesMap.set(edge.id, map);
  });
}

/**
 * Delete an edge by id — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to remove the edge from.
 * @param edgeId - Id of the edge to delete.
 */
export function removeEdge(
  projectId: string,
  spaceId: string,
  edgeId: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  doc.transact(() => {
    edgesMap.delete(edgeId);
  });
}

/**
 * Read all nodes from `nodesMap` into render-ready views. Each node's wire
 * fields are projected through `toNodeView`; nodes with a dirty / unknown
 * `type` or a missing `data` Y.Map are skipped.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current renderable canvas nodes.
 */
export function readNodes(doc: Y.Doc): ReadonlyArray<CanvasNodeView> {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
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
    const view = toNodeView(fields);
    if (!view) return;
    out.push({
      id: fields.id,
      type: view.kind,
      position: fields.position,
      data: view,
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
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  const out: CanvasEdge[] = [];
  edgesMap.forEach((map) => {
    if (!(map instanceof Y.Map)) return;
    out.push({
      id: String(map.get('id') ?? ''),
      source: String(map.get('source') ?? ''),
      target: String(map.get('target') ?? ''),
      kind: (map.get('kind') as CanvasEdge['kind']) ?? 'primary',
      toolId: (map.get('toolId') as string | undefined) ?? undefined,
    });
  });
  return out;
}
