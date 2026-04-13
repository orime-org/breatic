/**
 * Bridge between Yjs Map-of-Maps structure and Redux canvas state.
 *
 * Observes `nodesMap` and `edges` in the canvas Y.Map for deep
 * changes, converts Yjs types to ReactFlow Node[] / Edge[] arrays,
 * and dispatches to Redux. This replaces the old bidirectional
 * `yjsStoreSync` bridge — the new flow is strictly one-directional:
 *
 *   Yjs change → observe callback → dispatch setNodes / setEdges
 *
 * Write operations (addNode, updateNode, etc.) go directly to Yjs
 * through `useProjectStore`. The observe callback picks up the
 * change and syncs it back to Redux for ReactFlow to consume.
 */

import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { useDispatch } from 'react-redux';
import { setNodes, setEdges } from '@/store/modules/canvas';
import type { Node, Edge } from '@xyflow/react';
import type { YjsProjectManager } from '@/utils/yjsProjectManager';

/**
 * Convert a node Y.Map to a ReactFlow Node object.
 *
 * Only reads fields needed for canvas rendering. The prompt
 * (Y.XmlFragment) and attachments (Y.Array) are NOT read here —
 * they're only accessed when the node's editor is focused.
 */
function yMapToNode(nodeMap: Y.Map<unknown>, id: string): Node {
  const pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
  const handlingBy = nodeMap.get('handlingBy') as Y.Map<unknown> | undefined;

  return {
    id,
    type: (nodeMap.get('type') as string) ?? '1002',
    position: {
      x: pos instanceof Y.Map ? (pos.get('x') as number) ?? 0 : 0,
      y: pos instanceof Y.Map ? (pos.get('y') as number) ?? 0 : 0,
    },
    data: {
      name: (nodeMap.get('name') as string) ?? '',
      content: (nodeMap.get('content') as string) ?? '',
      coverUrl: nodeMap.get('coverUrl') as string | undefined,
      state: (nodeMap.get('state') as string) ?? 'idle',
      handlingBy: handlingBy instanceof Y.Map
        ? { userId: handlingBy.get('userId') as string, username: handlingBy.get('username') as string }
        : undefined,
      // nodeRuntimeData kept for backward compat with existing canvas
      // components that still read it. Will be removed when those
      // components are migrated to read directly from Y.Map.
      nodeRuntimeData: {},
    },
  };
}

/** Convert an edge Y.Map to a ReactFlow Edge object. */
function yMapToEdge(edgeMap: Y.Map<unknown>, id: string): Edge {
  return {
    id,
    source: (edgeMap.get('source') as string) ?? '',
    target: (edgeMap.get('target') as string) ?? '',
    sourceHandle: edgeMap.get('sourceHandle') as string | undefined,
    targetHandle: edgeMap.get('targetHandle') as string | undefined,
  };
}

/** Read all nodes from nodesMap and return as a ReactFlow Node[]. */
function readAllNodes(nodesMap: Y.Map<unknown>): Node[] {
  const result: Node[] = [];
  nodesMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(yMapToNode(value, key));
    }
  });
  return result;
}

/** Read all edges from edgesMap and return as a ReactFlow Edge[]. */
function readAllEdges(edgesMap: Y.Map<unknown>): Edge[] {
  const result: Edge[] = [];
  edgesMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(yMapToEdge(value, key));
    }
  });
  return result;
}

/**
 * Observe the Yjs canvas Map-of-Maps structure and keep Redux in
 * sync. Call this hook once per canvas session.
 *
 * @param manager - The active YjsProjectManager, or null if not
 *   yet initialized
 */
export function useCanvasYjs(manager: YjsProjectManager | null): void {
  const dispatch = useDispatch();
  const managerRef = useRef(manager);
  managerRef.current = manager;

  useEffect(() => {
    if (!manager) return;

    const { nodesMap, edgesMap } = manager;

    // Initial sync — read everything from Yjs into Redux.
    dispatch(setNodes(readAllNodes(nodesMap)));
    dispatch(setEdges(readAllEdges(edgesMap)));

    // Observe deep changes on nodesMap (covers nested Y.Map field
    // sets like position.x, state, content, handlingBy, etc.).
    const onNodesDeepChange = () => {
      dispatch(setNodes(readAllNodes(nodesMap)));
    };

    const onEdgesDeepChange = () => {
      dispatch(setEdges(readAllEdges(edgesMap)));
    };

    nodesMap.observeDeep(onNodesDeepChange);
    edgesMap.observeDeep(onEdgesDeepChange);

    return () => {
      nodesMap.unobserveDeep(onNodesDeepChange);
      edgesMap.unobserveDeep(onEdgesDeepChange);
    };
  }, [manager, dispatch]);
}
