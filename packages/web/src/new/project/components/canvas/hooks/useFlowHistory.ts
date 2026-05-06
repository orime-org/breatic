/**
 * Linear undo/redo for React Flow `nodes` + `edges` using plain snapshot arrays (no Yjs / Redux).
 * Records when graph structure or geometry (excluding selection-only) changes.
 */
import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Edge, Node } from '@xyflow/react';

const MAX_HISTORY = 100;

export type FlowHistorySnapshot = { nodes: Node[]; edges: Edge[] };

/**
 * JSON signature of canvas state for history: ignores `selected` and other transient UI flags.
 */
function historySignature(nodes: Node[], edges: Edge[]) {
  const n = nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
    parentId: node.parentId,
    style: node.style,
    width: node.width,
    height: node.height,
    zIndex: (node as Node & { zIndex?: number }).zIndex,
  }));
  const e = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }));
  return JSON.stringify({ nodes: n, edges: e });
}

function cloneSnapshot(s: FlowHistorySnapshot): FlowHistorySnapshot {
  return {
    nodes: structuredClone(s.nodes),
    edges: structuredClone(s.edges),
  };
}

export interface UseFlowHistoryResult {
  /** True when at least one undo step exists. */
  canUndo: boolean;
  /** True when at least one redo step exists. */
  canRedo: boolean;
  /** Apply previous snapshot. */
  undo: () => void;
  /** Re-apply next snapshot. */
  redo: () => void;
}

/**
 * Tracks `nodes` / `edges` and maintains undo/redo stacks.
 *
 * @param nodes - Current node list from React Flow state.
 * @param edges - Current edge list from React Flow state.
 * @param setNodes - React Flow `setNodes`.
 * @param setEdges - React Flow `setEdges`.
 * @returns Undo/redo controls and flags for toolbar / hotkeys.
 */
export function useFlowHistory(
  nodes: Node[],
  edges: Edge[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
  setEdges: Dispatch<SetStateAction<Edge[]>>,
): UseFlowHistoryResult {
  const past = useRef<FlowHistorySnapshot[]>([]);
  const future = useRef<FlowHistorySnapshot[]>([]);
  const restoring = useRef(false);
  const prevNodesRef = useRef<Node[] | null>(null);
  const prevEdgesRef = useRef<Edge[] | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  /** Bumps after stack mutations that do not always coincide with a nodes/edges render (first snapshot push). */
  const [histTick, setHistTick] = useState(0);
  const bump = useCallback(() => setHistTick((t) => t + 1), []);

  useLayoutEffect(() => {
    if (restoring.current) {
      prevNodesRef.current = structuredClone(nodes);
      prevEdgesRef.current = structuredClone(edges);
      queueMicrotask(() => {
        restoring.current = false;
      });
      return;
    }
    if (prevNodesRef.current === null || prevEdgesRef.current === null) {
      prevNodesRef.current = structuredClone(nodes);
      prevEdgesRef.current = structuredClone(edges);
      return;
    }
    const oldSig = historySignature(prevNodesRef.current, prevEdgesRef.current);
    const newSig = historySignature(nodes, edges);
    if (oldSig !== newSig) {
      past.current.push({
        nodes: structuredClone(prevNodesRef.current),
        edges: structuredClone(prevEdgesRef.current),
      });
      if (past.current.length > MAX_HISTORY) past.current.shift();
      future.current = [];
      bump();
    }
    prevNodesRef.current = structuredClone(nodes);
    prevEdgesRef.current = structuredClone(edges);
  }, [nodes, edges, bump]);

  const undo = useCallback(() => {
    if (past.current.length === 0) return;
    const snap = past.current.pop()!;
    future.current.push({
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
    });
    restoring.current = true;
    const next = cloneSnapshot(snap);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    if (future.current.length === 0) return;
    const snap = future.current.pop()!;
    past.current.push({
      nodes: structuredClone(nodesRef.current),
      edges: structuredClone(edgesRef.current),
    });
    restoring.current = true;
    const next = cloneSnapshot(snap);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [setNodes, setEdges]);

  void histTick;
  return {
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    undo,
    redo,
  };
}
