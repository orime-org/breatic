/**
 * `useCanvasSpace` — React state bridge for a canvas Space's Yjs doc.
 *
 * Replaces the pre-v10 `useCanvasYjsInternal` hook. Same observe-and-
 * incremental-rebuild model, same return shape, but bound to a
 * specific canvas-{spaceId} doc (v10 multi-doc layout) instead of the
 * project-wide single doc.
 *
 * The hook reads `nodesMap` and `edgesMap` at the **top level** of the
 * canvas-{spaceId} doc (no `canvas` wrapper Y.Map — that nesting was
 * pre-v10).
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import type { Node, Edge, NodeChange } from '@xyflow/react';
import type { CanvasSpaceManager } from '@/utils/yjsCanvasSpaceManager';
import type { CanvasToast } from '@/contexts/CanvasDataContext';

// ── Converters ─────────────────────────────────────────────────

function yArrayToPlainArray(arr: unknown): unknown[] {
  if (!(arr instanceof Y.Array)) return [];
  return arr.toArray().map((item) => {
    if (item instanceof Y.Map) return item.toJSON();
    return item;
  });
}

function yMapToNode(nodeMap: Y.Map<unknown>, id: string): Node {
  const pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
  const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;

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
          // ── State machine (canvas-native schema) ──────────────
          state: (dataMap.get('state') as string) ?? 'idle',
          handlingBy: dataMap.get('handlingBy') as { userId: string; username: string } | undefined,
          errorMessage: dataMap.get('errorMessage') as string | undefined,
          // ── Data node fields ──────────────────────────────────
          content: dataMap.get('content') as string | undefined,
          cover_url: dataMap.get('cover_url') as string | undefined,
          width: dataMap.get('width') as number | undefined,
          height: dataMap.get('height') as number | undefined,
          duration: dataMap.get('duration') as number | undefined,
          sourceNodeId: dataMap.get('sourceNodeId') as string | undefined,
          operation: dataMap.get('operation') as string | undefined,
          operationParams: dataMap.get('operationParams') as Record<string, unknown> | undefined,
          // ── Generative node fields ────────────────────────────
          model: dataMap.get('model') as string | undefined,
          modelParams: dataMap.get('modelParams') as Record<string, unknown> | undefined,
          // ── Common ───────────────────────────────────────────
          attachments: yArrayToPlainArray(dataMap.get('attachments')),
          // ── UI-only transient signals (not in Yjs history schema) ──
          pickState: dataMap.get('pickState') ?? undefined,
        }
      : { name: '', state: 'idle', attachments: [] },
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

// ── Incremental observe helper ─────────────────────────────────

function getAffectedNodeIds(
  events: Y.YEvent<Y.AbstractType<unknown>>[],
): Set<string> | 'all' {
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

// ── Local overlay (ReactFlow-only state) ───────────────────────

interface NodeLocalState {
  selected?: boolean;
  measured?: { width: number; height: number };
}

// ── Hook ───────────────────────────────────────────────────────

type PushToast = (toast: Omit<CanvasToast, 'id' | 'timestamp'>) => void;

export interface UseCanvasSpaceResult {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  syncError: string | null;
  applyLocalNodeChanges: (changes: NodeChange[]) => void;
}

/**
 * @param manager - The canvas Space manager from `useSpaceManagerPool`
 *   (or `null` while loading). Manages connection / undo for one
 *   `project-{pid}/canvas-{spaceId}` doc.
 * @param pushToast - Toast emitter for handling→idle state transitions.
 */
export function useCanvasSpace(
  manager: CanvasSpaceManager | null,
  pushToast: PushToast,
): UseCanvasSpaceResult {
  const [yjsNodes, setYjsNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const yjsNodesRef = useRef<Node[]>([]);

  const [localOverlay, setLocalOverlay] = useState<Map<string, NodeLocalState>>(new Map());

  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    if (!manager) {
      setYjsNodes([]);
      setEdges([]);
      yjsNodesRef.current = [];
      setLoading(false);
      setSyncError(null);
      return;
    }

    setLoading(true);
    setSyncError(null);
    let destroyed = false;

    const syncTimeout = setTimeout(() => {
      if (!destroyed && loading) {
        setSyncError('Connection timeout. Check your network and try again.');
        setLoading(false);
      }
    }, 15000);

    const unsubSynced = manager.onSynced(() => {
      if (destroyed) return;
      clearTimeout(syncTimeout);

      const { nodesMap, edgesMap } = manager;

      const initialNodes = readAllNodes(nodesMap);
      yjsNodesRef.current = initialNodes;
      setYjsNodes(initialNodes);
      setEdges(readAllEdges(edgesMap));
      setLoading(false);

      const onNodesDeepChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
        const affected = getAffectedNodeIds(events);

        if (affected === 'all') {
          const next = readAllNodes(nodesMap);
          yjsNodesRef.current = next;
          setYjsNodes(next);
          return;
        }

        const currentKeys = new Set<string>();
        nodesMap.forEach((_v, k) => currentKeys.add(k));

        const prev = yjsNodesRef.current;
        const next: Node[] = [];
        const rebuilt = new Set<string>();

        for (const node of prev) {
          if (!currentKeys.has(node.id)) {
            setLocalOverlay((m) => {
              if (!m.has(node.id)) return m;
              const copy = new Map(m);
              copy.delete(node.id);
              return copy;
            });
            continue;
          }
          if (affected.has(node.id)) {
            const ymap = nodesMap.get(node.id) as Y.Map<unknown>;
            if (ymap instanceof Y.Map) {
              const newNode = yMapToNode(ymap, node.id);

              const prevState = (node.data as { state?: string } | undefined)?.state;
              const nextState = (newNode.data as { state?: string } | undefined)?.state;
              const nextErrorMessage = (newNode.data as { errorMessage?: string } | undefined)?.errorMessage;
              if (prevState === 'handling' && nextState === 'idle') {
                pushToastRef.current({
                  nodeId: node.id,
                  nodeName: (newNode.data?.name as string) || node.id,
                  type: nextErrorMessage ? 'failed' : 'completed',
                });
              }

              next.push(newNode);
              rebuilt.add(node.id);
            }
          } else {
            next.push(node);
          }
        }

        Array.from(affected).forEach((id) => {
          if (!rebuilt.has(id) && currentKeys.has(id)) {
            const ymap = nodesMap.get(id) as Y.Map<unknown>;
            if (ymap instanceof Y.Map) {
              next.push(yMapToNode(ymap, id));
            }
          }
        });

        yjsNodesRef.current = next;
        setYjsNodes(next);
      };

      const onEdgesDeepChange = () => {
        setEdges(readAllEdges(edgesMap));
      };

      nodesMap.observeDeep(onNodesDeepChange);
      edgesMap.observeDeep(onEdgesDeepChange);

      cleanupObservers = () => {
        nodesMap.unobserveDeep(onNodesDeepChange);
        edgesMap.unobserveDeep(onEdgesDeepChange);
      };
    });

    let cleanupObservers: (() => void) | null = null;

    return () => {
      destroyed = true;
      clearTimeout(syncTimeout);
      unsubSynced();
      if (cleanupObservers) cleanupObservers();
    };
    // `loading` not in deps — it's read inside the timeout callback
    // and including it would re-run the whole effect on every state
    // tick. Same pattern as the pre-v10 useCanvasYjsInternal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager]);

  const nodes = useMemo(() => {
    if (localOverlay.size === 0) return yjsNodes;
    return yjsNodes.map((node) => {
      const overlay = localOverlay.get(node.id);
      if (!overlay) return node;
      return {
        ...node,
        ...(overlay.selected != null ? { selected: overlay.selected } : {}),
        ...(overlay.measured ? { measured: overlay.measured } : {}),
      };
    });
  }, [yjsNodes, localOverlay]);

  const applyLocalNodeChanges = useCallback((changes: NodeChange[]) => {
    setLocalOverlay((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const change of changes) {
        if (change.type === 'select') {
          const existing = next.get(change.id);
          if (existing?.selected !== change.selected) {
            next.set(change.id, { ...existing, selected: change.selected });
            changed = true;
          }
        } else if (change.type === 'dimensions' && change.dimensions) {
          const existing = next.get(change.id);
          const prevMeasured = existing?.measured;
          if (
            prevMeasured?.width !== change.dimensions.width ||
            prevMeasured?.height !== change.dimensions.height
          ) {
            next.set(change.id, {
              ...existing,
              measured: { width: change.dimensions.width, height: change.dimensions.height },
            });
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, []);

  return { nodes, edges, loading, syncError, applyLocalNodeChanges };
}
