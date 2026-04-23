/**
 * Internal Yjs → React state bridge for {@link MixedEditorDataContext}.
 *
 * Wait for Hocuspocus initial sync → full-read the `flow` Y.Map →
 * subscribe observeDeep → incrementally rebuild only affected entries,
 * reusing references for unchanged nodes so ReactFlow re-renders stay
 * surgical.
 *
 * UI-only overlay (select / dimensions / pickState) lives in
 * {@link MixedEditorDataProvider}, not here — this hook is purely
 * "Yjs → React state" and returns the raw Yjs node list plus sync
 * status.
 *
 * Mixed editor schema (YJS.md § 11):
 *
 *     flow: Y.Map<nodeId, Y.Map>   ← flat, no edges
 *       each node Y.Map:
 *         id:       string
 *         type:     '2002' | '2003' | '2004' | 'group'
 *         position: Y.Map { x, y }
 *         style:    Y.Map { width, height }
 *         zIndex:   number   (optional)
 *         parentId: string   (optional — for group nesting)
 *         extent:   unknown  (optional — ReactFlow extent)
 *         data:     Y.Map    (ImageEditorNodeData)
 *           name:        string
 *           content:     string
 *           state:       'idle' | 'handling'    (never 'localPending' —
 *                                                 X pattern keeps that
 *                                                 value local-only)
 *           runType?:    'parameter' | 'sensitive'
 *           handlingBy?: Y.Map { userId, username, heartbeatAt }
 *           nodeRuntimeData?: Y.Map (per-node runtime state)
 *
 * The mixed editor flow has no edges (product is a "bag of sibling
 * nodes" — crops, filters, variations — not a DAG). `edges` is
 * exposed as a stable empty array for ReactFlow host parity.
 *
 * @internal
 */

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { Node, Edge } from '@xyflow/react';
import type { YjsNodeEditorManager } from '@/utils/yjsNodeEditorManager';

// ── Converters ─────────────────────────────────────────────────

function yMapDataToPlain(dataMap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  dataMap.forEach((v, k) => {
    if (v instanceof Y.Map) {
      const nested: Record<string, unknown> = {};
      (v as Y.Map<unknown>).forEach((vv, kk) => { nested[kk] = vv; });
      obj[k] = nested;
    } else {
      obj[k] = v;
    }
  });
  return obj;
}

function yMapToNode(nodeMap: Y.Map<unknown>, id: string): Node {
  const pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
  const style = nodeMap.get('style') as Y.Map<unknown> | undefined;
  const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
  const type = (nodeMap.get('type') as string) ?? '2002';
  const zIndex = nodeMap.get('zIndex') as number | undefined;
  const parentId = nodeMap.get('parentId') as string | undefined;
  const extent = nodeMap.get('extent') as Node['extent'] | undefined;
  const draggable = nodeMap.get('draggable') as boolean | undefined;

  const node: Node = {
    id,
    type,
    position: {
      x: pos instanceof Y.Map ? (pos.get('x') as number) ?? 0 : 0,
      y: pos instanceof Y.Map ? (pos.get('y') as number) ?? 0 : 0,
    },
    data: dataMap instanceof Y.Map ? yMapDataToPlain(dataMap) : {},
  };

  if (style instanceof Y.Map) {
    const w = style.get('width') as number | undefined;
    const h = style.get('height') as number | undefined;
    const styleObj: Record<string, unknown> = {};
    if (typeof w === 'number') styleObj.width = w;
    if (typeof h === 'number') styleObj.height = h;
    if (Object.keys(styleObj).length > 0) {
      node.style = styleObj;
    }
  }
  if (typeof zIndex === 'number') {
    (node as Node & { zIndex?: number }).zIndex = zIndex;
  }
  if (typeof parentId === 'string') node.parentId = parentId;
  if (extent !== undefined) node.extent = extent;
  if (typeof draggable === 'boolean') node.draggable = draggable;

  return node;
}

function readAllNodes(flow: Y.Map<unknown>): Node[] {
  const result: Node[] = [];
  flow.forEach((value, key) => {
    if (value instanceof Y.Map) {
      result.push(yMapToNode(value, key));
    }
  });
  return result;
}

// ── Incremental observe helpers ────────────────────────────────

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
      if (typeof nodeId === 'string') ids.add(nodeId);
    }
  }
  return ids;
}

// ── Hook ───────────────────────────────────────────────────────

export interface MixedEditorYjsInternalResult {
  nodes: Node[];
  edges: Edge[];
  loading: boolean;
  syncError: string | null;
}

const EMPTY_EDGES: Edge[] = [];
const SYNC_TIMEOUT_MS = 15_000;

export function useMixedEditorYjsInternal(
  manager: YjsNodeEditorManager | null,
): MixedEditorYjsInternalResult {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const nodesRef = useRef<Node[]>([]);

  useEffect(() => {
    if (!manager) {
      setNodes([]);
      nodesRef.current = [];
      setLoading(false);
      setSyncError(null);
      return;
    }

    setLoading(true);
    setSyncError(null);
    let destroyed = false;

    const syncTimeout = setTimeout(() => {
      if (destroyed) return;
      setSyncError('Connection timeout. Check your network and try again.');
      setLoading(false);
    }, SYNC_TIMEOUT_MS);

    let cleanupObservers: (() => void) | null = null;

    const unsubSynced = manager.onSynced(() => {
      if (destroyed) return;
      clearTimeout(syncTimeout);

      const flow = manager.doc.getMap('flow') as Y.Map<unknown>;

      const initial = readAllNodes(flow);
      nodesRef.current = initial;
      setNodes(initial);
      setLoading(false);

      const onFlowDeepChange = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
        const affected = getAffectedNodeIds(events);
        if (affected === 'all') {
          const next = readAllNodes(flow);
          nodesRef.current = next;
          setNodes(next);
          return;
        }

        const currentKeys = new Set<string>();
        flow.forEach((_v, k) => currentKeys.add(k));

        const prev = nodesRef.current;
        const next: Node[] = [];
        const rebuilt = new Set<string>();

        for (const node of prev) {
          if (!currentKeys.has(node.id)) continue; // deleted
          if (affected.has(node.id)) {
            const ymap = flow.get(node.id) as Y.Map<unknown>;
            if (ymap instanceof Y.Map) {
              next.push(yMapToNode(ymap, node.id));
              rebuilt.add(node.id);
            }
          } else {
            next.push(node); // reuse reference
          }
        }

        // Newly added
        for (const id of affected) {
          if (!rebuilt.has(id) && currentKeys.has(id)) {
            const ymap = flow.get(id) as Y.Map<unknown>;
            if (ymap instanceof Y.Map) {
              next.push(yMapToNode(ymap, id));
            }
          }
        }

        nodesRef.current = next;
        setNodes(next);
      };

      flow.observeDeep(onFlowDeepChange);
      cleanupObservers = () => flow.unobserveDeep(onFlowDeepChange);
    });

    return () => {
      destroyed = true;
      clearTimeout(syncTimeout);
      unsubSynced();
      if (cleanupObservers) cleanupObservers();
    };
  }, [manager]);

  return { nodes, edges: EMPTY_EDGES, loading, syncError };
}
