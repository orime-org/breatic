import * as React from 'react';
import * as Y from 'yjs';

import type {
  CanvasNode,
  NodeData,
} from '@web/spaces/canvas/types/node';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket } from '@web/data/yjs/use-socket';

/**
 * Canvas-space Yjs document — single source of truth for one canvas
 * space's nodes + edges.
 *
 * Y.Doc structure:
 *   - Y.Map("nodes") of Y.Map<{ id, kind, position, data }>
 *   - Y.Map("edges") of Y.Map<{ id, source, target, kind, toolId? }>
 *
 * Frontend owns node create / delete / position. Backend (Worker via
 * Collab service) only writes the `data` field (state / content / url).
 *
 * The hooks return ReactFlow-ready arrays; ReactFlow consumes these
 * directly via `useNodesState` / `useEdgesState` replacement.
 */

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  kind: 'primary' | 'reference';
  toolId?: string;
}

interface CanvasSpaceState {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  synced: boolean;
}

const NODES_KEY = 'nodes';
const EDGES_KEY = 'edges';

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
  const [nodes, setNodes] = React.useState<ReadonlyArray<CanvasNode>>(() =>
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
 * Add a node — frontend-owned operation.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space to add the node to.
 * @param node - The node to insert (id, kind, position, data).
 */
export function addNode(
  projectId: string,
  spaceId: string,
  node: CanvasNode,
): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', node.id);
    m.set('kind', node.data.kind);
    m.set('position', node.position);
    m.set('data', node.data);
    nodesMap.set(node.id, m);
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
    const m = new Y.Map<unknown>();
    m.set('id', edge.id);
    m.set('source', edge.source);
    m.set('target', edge.target);
    m.set('kind', edge.kind);
    if (edge.toolId) m.set('toolId', edge.toolId);
    edgesMap.set(edge.id, m);
  });
}

/**
 * Read all nodes from the doc's `nodes` map into a ReactFlow-ready array.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current canvas nodes, with defaults applied for missing fields.
 */
function readNodes(doc: Y.Doc): ReadonlyArray<CanvasNode> {
  const nodesMap = doc.getMap<Y.Map<unknown>>(NODES_KEY);
  const out: CanvasNode[] = [];
  nodesMap.forEach((m) => {
    out.push({
      id: String(m.get('id') ?? ''),
      kind: m.get('kind') as CanvasNode['kind'],
      position: (m.get('position') as { x: number; y: number }) ?? {
        x: 0,
        y: 0,
      },
      data: (m.get('data') as NodeData) ?? {
        kind: 'text',
        content: '',
        status: 'idle',
      },
    });
  });
  return out;
}

/**
 * Read all edges from the doc's `edges` map into a ReactFlow-ready array.
 * @param doc - The canvas-space Y.Doc to read from.
 * @returns The current canvas edges, with defaults applied for missing fields.
 */
function readEdges(doc: Y.Doc): ReadonlyArray<CanvasEdge> {
  const edgesMap = doc.getMap<Y.Map<unknown>>(EDGES_KEY);
  const out: CanvasEdge[] = [];
  edgesMap.forEach((m) => {
    out.push({
      id: String(m.get('id') ?? ''),
      source: String(m.get('source') ?? ''),
      target: String(m.get('target') ?? ''),
      kind: (m.get('kind') as CanvasEdge['kind']) ?? 'primary',
      toolId: (m.get('toolId') as string | undefined) ?? undefined,
    });
  });
  return out;
}
