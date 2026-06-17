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
  /** Undo the last tracked structural / metadata / name edit by this client. */
  undo: () => void;
  /** Redo the last undone edit by this client. */
  redo: () => void;
  /** Whether an undo is currently available (drives the toolbar button). */
  canUndo: boolean;
  /** Whether a redo is currently available (drives the toolbar button). */
  canRedo: boolean;
}

const NODES_KEY = 'nodesMap';
const EDGES_KEY = 'edgesMap';

/**
 * Tracked transaction origin for canvas undo. Every frontend structural /
 * metadata / name write below runs in `doc.transact(fn, CANVAS_UNDO)` so the
 * per-space `Y.UndoManager` captures it. Backend content writes use a
 * different origin (`'node-state-update'`, see collab `task-listener`) and so
 * are naturally excluded from the undo stack.
 */
export const CANVAS_UNDO = Symbol('canvas-undo');

/** Max canvas undo stack depth — oldest entries are dropped past this. */
export const MAX_UNDO_DEPTH = 50;

/**
 * Create a per-space canvas undo manager scoped to the node + edge maps.
 * Captures only `CANVAS_UNDO`-origin transactions (this client's own
 * structural / metadata / name edits); remote collaborator writes carry the
 * sync provider as origin and are excluded, so undo is per-client.
 *
 * `captureTimeout: 0` disables time-based merging so two separate actions
 * never collapse into one undo step; a drag is already one entry because
 * `setNodePosition` is committed once on drag-end.
 *
 * The stack is capped at {@link MAX_UNDO_DEPTH} by trimming the oldest in
 * place on each push (Y.UndoManager has no native maxDepth). The dropped
 * tail's `keepItem` flags are not released (no public API) — a bounded,
 * accepted leak (design doc §3 / §9.1, decision B.1).
 * @param doc - The canvas-space Y.Doc whose nodes + edges to track.
 * @returns A Y.UndoManager bound to the doc's node and edge maps.
 */
export function createCanvasUndoManager(doc: Y.Doc): Y.UndoManager {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  const undoManager = new Y.UndoManager([nodesMap, edgesMap], {
    trackedOrigins: new Set([CANVAS_UNDO]),
    captureTimeout: 0,
  });
  undoManager.on('stack-item-added', () => {
    while (undoManager.undoStack.length > MAX_UNDO_DEPTH) {
      undoManager.undoStack.shift();
    }
  });
  return undoManager;
}

/**
 * Subscribe to a canvas-space document.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space whose nodes and edges to observe.
 * @returns The current nodes, edges, sync flag, and per-space undo controls.
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

  // Per-space undo manager. Created + destroyed in one effect keyed on the
  // doc (StrictMode-safe, same pattern as useSocket): a page refresh is a new
  // JS context so the stack is empty by construction (design decision: refresh
  // clears history). `canUndo` / `canRedo` are mirrored into React state from
  // the manager's stack events so the toolbar buttons stay in sync.
  const undoManagerRef = React.useRef<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  React.useEffect(() => {
    const undoManager = createCanvasUndoManager(doc);
    undoManagerRef.current = undoManager;
    /** Re-read undo/redo availability from the manager into React state. */
    const sync = (): void => {
      setCanUndo(undoManager.canUndo());
      setCanRedo(undoManager.canRedo());
    };
    undoManager.on('stack-item-added', sync);
    undoManager.on('stack-item-popped', sync);
    undoManager.on('stack-cleared', sync);
    sync();
    return () => {
      undoManager.off('stack-item-added', sync);
      undoManager.off('stack-item-popped', sync);
      undoManager.off('stack-cleared', sync);
      undoManager.destroy();
      undoManagerRef.current = null;
    };
  }, [doc]);

  const undo = React.useCallback((): void => {
    undoManagerRef.current?.undo();
  }, []);
  const redo = React.useCallback((): void => {
    undoManagerRef.current?.redo();
  }, []);

  return { nodes, edges, synced, undo, redo, canUndo, canRedo };
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
  }, CANVAS_UNDO);
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
  }, CANVAS_UNDO);
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
  doc.transact(() => node.set('position', position), CANVAS_UNDO);
}

/**
 * Rename a node (name-header edit) — frontend-owned operation. Writes into
 * the nested `data` Y.Map so the change merges field-wise with concurrent
 * collaborator / backend writes.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to rename.
 * @param name - The node's new display name.
 */
export function setNodeName(
  projectId: string,
  spaceId: string,
  nodeId: string,
  name: string,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => data.set('name', name), CANVAS_UNDO);
}

/**
 * Lock / unlock a node — frontend-owned operation. Writes into the nested
 * `data` Y.Map so the flag merges field-wise with concurrent collaborator /
 * backend writes.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - Id of the node to lock / unlock.
 * @param locked - The node's new lock state.
 */
export function setNodeLocked(
  projectId: string,
  spaceId: string,
  nodeId: string,
  locked: boolean,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const node = nodesMap.get(nodeId);
  if (!node) return;
  const data = node.get('data');
  if (!(data instanceof Y.Map)) return;
  doc.transact(() => data.set('locked', locked), CANVAS_UNDO);
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
  }, CANVAS_UNDO);
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
  }, CANVAS_UNDO);
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
