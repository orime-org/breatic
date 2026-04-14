/**
 * Bridge between Yjs Map-of-Maps structure and Redux canvas state.
 *
 * Observes `nodesMap` and `edges` in the canvas Y.Map for deep
 * changes, converts Yjs types to ReactFlow Node[] / Edge[] arrays,
 * and dispatches to Redux. The flow is strictly one-directional:
 *
 *   Yjs change → observe callback → dispatch setNodes / setEdges
 *
 * **Incremental observe**: instead of rebuilding all nodes on every
 * change, we identify which node IDs were affected and only
 * reconstruct those. Unchanged nodes keep their old object reference
 * so React's shallow comparison skips re-renders.
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
 * Reads top-level `id`, `type`, `position` and nested `data` Y.Map
 * for canvas-rendering fields. The prompt (Y.XmlFragment) and
 * attachments (Y.Array) are NOT read here — they're only accessed
 * when the node's editor is focused.
 */
function yMapToNode(nodeMap: Y.Map<unknown>, id: string): Node {
  const pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
  const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
  const handlingBy = dataMap instanceof Y.Map
    ? dataMap.get('handlingBy') as Y.Map<unknown> | undefined
    : undefined;

  return {
    id,
    type: (nodeMap.get('type') as string) ?? '1002',
    position: {
      x: pos instanceof Y.Map ? (pos.get('x') as number) ?? 0 : 0,
      y: pos instanceof Y.Map ? (pos.get('y') as number) ?? 0 : 0,
    },
    data: dataMap instanceof Y.Map
      ? {
          name: (dataMap.get('name') as string) ?? '',
          content: (dataMap.get('content') as string) ?? '',
          coverUrl: dataMap.get('coverUrl') as string | undefined,
          state: (dataMap.get('state') as string) ?? 'idle',
          handlingBy: handlingBy instanceof Y.Map
            ? { userId: handlingBy.get('userId') as string, username: handlingBy.get('username') as string }
            : undefined,
          runType: dataMap.get('runType') as string | undefined,
        }
      : {
          name: '',
          content: '',
          state: 'idle',
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
 * Extract affected node IDs from observeDeep events.
 *
 * - Events with empty path `[]` are top-level nodesMap add/delete
 *   → we need to check `event.changes.keys` for affected IDs.
 * - Events with path `[nodeId, ...]` are nested field changes
 *   → the first path segment is the node ID.
 */
function getAffectedNodeIds(events: Y.YEvent<Y.AbstractType<unknown>>[]): Set<string> | 'all' {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.path.length === 0) {
      // Top-level change (node added/deleted from nodesMap).
      // Check keys for specific IDs; if keys changed, it's add/delete.
      if (event.changes.keys.size > 0) {
        event.changes.keys.forEach((_change, key) => ids.add(key));
      } else {
        // Fallback: rebuild all
        return 'all';
      }
    } else {
      // Nested change — first path element is the node ID.
      const nodeId = event.path[0];
      if (typeof nodeId === 'string') {
        ids.add(nodeId);
      }
    }
  }
  return ids;
}

/**
 * Observe the Yjs canvas Map-of-Maps structure and keep Redux in
 * sync. Call this hook once per canvas session.
 *
 * Uses incremental observation: only rebuilds Node objects for
 * changed node IDs, reusing old references for the rest.
 *
 * @param manager - The active YjsProjectManager, or null if not
 *   yet initialized
 */
export function useCanvasYjs(manager: YjsProjectManager | null): void {
  const dispatch = useDispatch();
  const managerRef = useRef(manager);
  managerRef.current = manager;

  // Keep a ref to the latest nodes array so incremental updates
  // can merge changed nodes with unchanged ones.
  const nodesRef = useRef<Node[]>([]);

  useEffect(() => {
    if (!manager) return;

    const { nodesMap, edgesMap } = manager;

    // Initial sync — read everything from Yjs into Redux.
    const initialNodes = readAllNodes(nodesMap);
    nodesRef.current = initialNodes;
    dispatch(setNodes(initialNodes));
    dispatch(setEdges(readAllEdges(edgesMap)));

    // Incremental observe for nodes.
    const onNodesDeepChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const affected = getAffectedNodeIds(events);

      if (affected === 'all') {
        const next = readAllNodes(nodesMap);
        nodesRef.current = next;
        dispatch(setNodes(next));
        return;
      }

      // Build a set of current nodesMap keys to detect deletions.
      const currentKeys = new Set<string>();
      nodesMap.forEach((_v, k) => currentKeys.add(k));

      const prev = nodesRef.current;
      // Filter out deleted nodes and update changed ones.
      const next: Node[] = [];
      const rebuilt = new Set<string>();

      for (const node of prev) {
        if (!currentKeys.has(node.id)) {
          // Node was deleted — skip.
          continue;
        }
        if (affected.has(node.id)) {
          const ymap = nodesMap.get(node.id) as Y.Map<unknown>;
          if (ymap instanceof Y.Map) {
            next.push(yMapToNode(ymap, node.id));
            rebuilt.add(node.id);
          }
        } else {
          // Unchanged — reuse old reference.
          next.push(node);
        }
      }

      // Add newly created nodes (in affected but not in prev).
      for (const id of affected) {
        if (!rebuilt.has(id) && currentKeys.has(id)) {
          const ymap = nodesMap.get(id) as Y.Map<unknown>;
          if (ymap instanceof Y.Map) {
            next.push(yMapToNode(ymap, id));
          }
        }
      }

      nodesRef.current = next;
      dispatch(setNodes(next));
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
