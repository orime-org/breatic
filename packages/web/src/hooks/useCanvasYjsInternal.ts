/**
 * Internal Yjs → React state bridge for CanvasDataContext.
 *
 * Unlike the original {@link useCanvasYjs} which dispatches to Redux,
 * this hook returns `{ nodes, edges }` directly via useState. It also
 * detects `handling → idle` transitions and pushes toast notifications.
 *
 * This hook is NOT meant to be called directly — use it through
 * {@link CanvasDataProvider} which wraps it with toast state.
 *
 * @internal
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import type { Node, Edge } from '@xyflow/react';
import type { YjsProjectManager } from '@/utils/yjsProjectManager';
import type { CanvasToast } from '@/contexts/CanvasDataContext';

// ── Converters ─────────────────────────────────────────────────

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
      : { name: '', content: '', state: 'idle' },
  };
}

function yMapToEdge(edgeMap: Y.Map<unknown>, id: string): Edge {
  return {
    id,
    source: (edgeMap.get('source') as string) ?? '',
    target: (edgeMap.get('target') as string) ?? '',
    sourceHandle: edgeMap.get('sourceHandle') as string | undefined,
    targetHandle: edgeMap.get('targetHandle') as string | undefined,
  };
}

function readAllNodes(nodesMap: Y.Map<unknown>): Node[] {
  const result: Node[] = [];
  nodesMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(yMapToNode(value, key));
    }
  });
  return result;
}

function readAllEdges(edgesMap: Y.Map<unknown>): Edge[] {
  const result: Edge[] = [];
  edgesMap.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(yMapToEdge(value, key));
    }
  });
  return result;
}

// ── Incremental observe helpers ────────────────────────────────

function getAffectedNodeIds(events: Y.YEvent<Y.AbstractType<unknown>>[]): Set<string> | 'all' {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.path.length === 0) {
      if (event.changes.keys.size > 0) {
        event.changes.keys.forEach((_change, key) => ids.add(key));
      } else {
        return 'all';
      }
    } else {
      const nodeId = event.path[0];
      if (typeof nodeId === 'string') {
        ids.add(nodeId);
      }
    }
  }
  return ids;
}

// ── Hook ───────────────────────────────────────────────────────

type PushToast = (toast: Omit<CanvasToast, 'id' | 'timestamp'>) => void;

export function useCanvasYjsInternal(
  manager: YjsProjectManager | null,
  pushToast: PushToast,
): { nodes: Node[]; edges: Edge[] } {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef<Node[]>([]);

  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    if (!manager) return;

    const { nodesMap, edgesMap } = manager;

    // Initial sync
    const initialNodes = readAllNodes(nodesMap);
    nodesRef.current = initialNodes;
    setNodes(initialNodes);
    setEdges(readAllEdges(edgesMap));

    // Incremental observe for nodes
    const onNodesDeepChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const affected = getAffectedNodeIds(events);

      if (affected === 'all') {
        const next = readAllNodes(nodesMap);
        nodesRef.current = next;
        setNodes(next);
        return;
      }

      const currentKeys = new Set<string>();
      nodesMap.forEach((_v, k) => currentKeys.add(k));

      const prev = nodesRef.current;
      const next: Node[] = [];
      const rebuilt = new Set<string>();

      for (const node of prev) {
        if (!currentKeys.has(node.id)) continue;
        if (affected.has(node.id)) {
          const ymap = nodesMap.get(node.id) as Y.Map<unknown>;
          if (ymap instanceof Y.Map) {
            const newNode = yMapToNode(ymap, node.id);

            // Detect handling → idle transition for toast
            if (node.data?.state === 'handling' && newNode.data?.state === 'idle') {
              const hasNewContent = newNode.data?.content !== node.data?.content;
              pushToastRef.current({
                nodeId: node.id,
                nodeName: (newNode.data?.name as string) || node.id,
                type: hasNewContent ? 'completed' : 'failed',
              });
            }

            next.push(newNode);
            rebuilt.add(node.id);
          }
        } else {
          next.push(node);
        }
      }

      // Add newly created nodes
      for (const id of affected) {
        if (!rebuilt.has(id) && currentKeys.has(id)) {
          const ymap = nodesMap.get(id) as Y.Map<unknown>;
          if (ymap instanceof Y.Map) {
            next.push(yMapToNode(ymap, id));
          }
        }
      }

      nodesRef.current = next;
      setNodes(next);
    };

    const onEdgesDeepChange = () => {
      setEdges(readAllEdges(edgesMap));
    };

    nodesMap.observeDeep(onNodesDeepChange);
    edgesMap.observeDeep(onEdgesDeepChange);

    return () => {
      nodesMap.unobserveDeep(onNodesDeepChange);
      edgesMap.unobserveDeep(onEdgesDeepChange);
    };
  }, [manager]);

  return { nodes, edges };
}
