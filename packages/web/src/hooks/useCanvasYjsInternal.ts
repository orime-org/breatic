/**
 * Internal Yjs → React state bridge for CanvasDataContext.
 *
 * Architecture: Yjs data and local UI state are stored separately
 * and merged via useMemo. This eliminates race conditions between
 * Yjs observe updates and ReactFlow local changes (select, dimensions).
 *
 * ```
 * yjsNodes  ← Yjs observeDeep (data from collaboration)
 * localOverlay ← ReactFlow select/dimensions (local UI state)
 *          ↓ useMemo merge
 *     nodes → ReactFlow rendering
 * ```
 *
 * @internal
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as Y from 'yjs';
import { type Node, type Edge, type NodeChange } from '@xyflow/react';
import type { YjsProjectManager } from '@/utils/yjsProjectManager';
import type { CanvasToast } from '@/contexts/CanvasDataContext';

// ── Converters ─────────────────────────────────────────────────

/** Serialize a Y.Map to a plain object. */
function yMapToPlain(ymap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  ymap.forEach((v, k) => { obj[k] = v; });
  return obj;
}

function yMapToNode(nodeMap: Y.Map<unknown>, id: string): Node {
  const pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
  const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
  const handlingBy = dataMap instanceof Y.Map
    ? dataMap.get('handlingBy') as Y.Map<unknown> | undefined
    : undefined;
  const paramsMap = dataMap instanceof Y.Map
    ? dataMap.get('params') as Y.Map<unknown> | undefined
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
        params: paramsMap instanceof Y.Map ? yMapToPlain(paramsMap) : {},
      }
      : { name: '', content: '', state: 'idle', params: {} },
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  applyLocalNodeChanges: (changes: NodeChange[]) => void;
} {
  // Yjs-derived data (only updated by observe callbacks)
  const [yjsNodes, setYjsNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const yjsNodesRef = useRef<Node[]>([]);

  // Local UI overlay (only updated by ReactFlow select/dimensions)
  const [localOverlay, setLocalOverlay] = useState<Map<string, NodeLocalState>>(new Map());

  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  // ── Yjs observe ──────────────────────────────────────────────

  useEffect(() => {
    if (!manager) return;

    const { canvasMap } = manager;

    // Helper: get nodesMap/edgesMap fresh from canvasMap each time.
    // Before WebSocket sync, these may not exist. After sync, canvasMap
    // is populated with the server state. Always reading fresh avoids
    // holding a stale reference to a pre-sync Y.Map.
    const getNodesMap = (): Y.Map<unknown> | null => {
      const m = canvasMap.get('nodesMap');
      return m instanceof Y.Map ? m as Y.Map<unknown> : null;
    };
    const getEdgesMap = (): Y.Map<unknown> | null => {
      const m = canvasMap.get('edges');
      return m instanceof Y.Map ? m as Y.Map<unknown> : null;
    };

    // Initial sync (nodesMap may be empty before WebSocket sync completes)
    const nodesMap = getNodesMap();
    const edgesMap = getEdgesMap();
    const initialNodes = nodesMap ? readAllNodes(nodesMap) : [];
    yjsNodesRef.current = initialNodes;
    setYjsNodes(initialNodes);
    setEdges(edgesMap ? readAllEdges(edgesMap) : []);

    // Incremental observe for nodes
    // Observe canvasMap (not nodesMap/edgesMap directly) so we catch
    // WebSocket sync events that populate nodesMap for the first time.
    // Reading getNodesMap()/getEdgesMap() fresh each time avoids stale refs.
    const onCanvasDeepChange = () => {
      const currentNodesMap = getNodesMap();
      const currentEdgesMap = getEdgesMap();

      // Rebuild nodes
      const nextNodes = currentNodesMap ? readAllNodes(currentNodesMap) : [];

      // Detect handling → idle transitions for toast
      const prev = yjsNodesRef.current;
      const prevById = new Map(prev.map((n) => [n.id, n]));
      for (const node of nextNodes) {
        const old = prevById.get(node.id);
        if (old?.data?.state === 'handling' && node.data?.state === 'idle') {
          const hasNewContent = node.data?.content !== old.data?.content;
          pushToastRef.current({
            nodeId: node.id,
            nodeName: (node.data?.name as string) || node.id,
            type: hasNewContent ? 'completed' : 'failed',
          });
        }
      }

      // Clean overlay for deleted nodes
      const nextIds = new Set(nextNodes.map((n) => n.id));
      for (const old of prev) {
        if (!nextIds.has(old.id)) {
          setLocalOverlay((m) => {
            if (!m.has(old.id)) return m;
            const copy = new Map(m);
            copy.delete(old.id);
            return copy;
          });
        }
      }

      yjsNodesRef.current = nextNodes;
      setYjsNodes(nextNodes);
      setEdges(currentEdgesMap ? readAllEdges(currentEdgesMap) : []);
    };

    // Use doc.on('update') instead of canvasMap.observeDeep because
    // HocuspocusProvider applies remote updates at the Y.Doc level
    // via Y.applyUpdate(), which doesn't always fire nested map observers
    // when the update creates new sub-structures.
    const onDocUpdate = () => onCanvasDeepChange();
    manager.doc.on('update', onDocUpdate);

    // Also subscribe to canvasMap for local writes (belt & suspenders)
    canvasMap.observeDeep(onCanvasDeepChange);

    return () => {
      manager.doc.off('update', onDocUpdate);
      canvasMap.unobserveDeep(onCanvasDeepChange);
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

  return { nodes, edges, applyLocalNodeChanges };
}
