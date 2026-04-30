/**
 * Internal Yjs → React state bridge for CanvasDataContext.
 *
 * Simple architecture: wait for sync → subscribe observeDeep →
 * incremental rebuild. No fallback, no debounce, no zombie detection.
 *
 * Requires server sync to complete before initialization (no offline
 * mode — product requires network for AIGC). This eliminates all
 * race conditions between cache and server state.
 *
 * @internal
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import type { Node, Edge, NodeChange } from '@xyflow/react';
import type { YjsProjectManager } from '@/utils/yjsProjectManager';
import type { CanvasToast } from '@/contexts/CanvasDataContext';

// ── Converters ─────────────────────────────────────────────────

/**
 * Convert a `Y.Array<Y.Map>` to a plain-JS array by calling
 * `.toJSON()` on each item map.  Returns an empty array if the
 * value is not a Y.Array.
 */
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

// ── Local overlay for ReactFlow-only state ─────────────────────

interface NodeLocalState {
  selected?: boolean;
  measured?: { width: number; height: number };
}

// ── Hook ───────────────────────────────────────────────────────

type PushToast = (toast: Omit<CanvasToast, 'id' | 'timestamp'>) => void;

export function useCanvasYjsInternal(
  manager: YjsProjectManager | null,
  pushToast: PushToast,
): {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  syncError: string | null;
  applyLocalNodeChanges: (changes: NodeChange[]) => void;
} {
  const [yjsNodes, setYjsNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const yjsNodesRef = useRef<Node[]>([]);

  const [localOverlay, setLocalOverlay] = useState<Map<string, NodeLocalState>>(new Map());

  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  // ── Wait for sync, then subscribe observeDeep ────────────────

  useEffect(() => {
    if (!manager) return;

    setLoading(true);
    setSyncError(null);
    let destroyed = false;

    // Timeout: if sync doesn't complete in 15 seconds, show error
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

      // Full read after sync
      const initialNodes = readAllNodes(nodesMap);
      yjsNodesRef.current = initialNodes;
      setYjsNodes(initialNodes);
      setEdges(readAllEdges(edgesMap));
      setLoading(false);

      // Subscribe observeDeep — incremental updates from now on
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
            // Deleted — clean overlay
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

              // Toast: node transitions from handling → idle (completed or failed).
              // Canvas-native schema: state machine transition, not history-array diff.
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
            next.push(node); // unchanged → reuse reference
          }
        }

        // Add newly created nodes
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

      // Store cleanup for when effect re-runs
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
  }, [manager]);

  // ── Merge: yjsNodes + localOverlay → final nodes ─────────────

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

  // ── Local changes (select, dimensions) ───────────────────────

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
          if (prevMeasured?.width !== change.dimensions.width || prevMeasured?.height !== change.dimensions.height) {
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
