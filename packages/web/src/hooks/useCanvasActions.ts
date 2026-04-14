/**
 * Canvas write operations — all writes go directly to Yjs.
 *
 * Extracted from `useProjectStore` as part of the three-hook split:
 * - {@link useCanvasData} — read nodes/edges/toasts (Context)
 * - **useCanvasActions** — write nodes/edges (Yjs)
 * - {@link useCanvasUI} — read/write UI state (Redux)
 */

import { useCallback } from 'react';
import * as Y from 'yjs';
import { getCanvasYjsManager } from '@/utils/canvasYjsRef';
import { userOrigin, noHistoryOrigin } from '@/utils/yjsProjectManager';
import type { NodeChange, EdgeChange, Connection, Node, Edge } from '@xyflow/react';

type HistoryOptions = { history?: 'default' | 'skip' };

function getOrigin(options?: HistoryOptions): string | symbol {
  return options?.history === 'skip' ? noHistoryOrigin : userOrigin;
}

export function useCanvasActions() {
  const addNode = useCallback(
    (node: Node, options?: { select?: boolean } & HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        const nodeMap = new Y.Map();
        nodeMap.set('id', node.id);
        nodeMap.set('type', node.type ?? '1002');
        const pos = new Y.Map();
        pos.set('x', node.position?.x ?? 0);
        pos.set('y', node.position?.y ?? 0);
        nodeMap.set('position', pos);

        const dataMap = new Y.Map();
        dataMap.set('name', node.data?.name ?? '');
        dataMap.set('state', 'idle');
        dataMap.set('content', node.data?.content ?? '');
        dataMap.set('prompt', new Y.XmlFragment());
        dataMap.set('attachments', new Y.Array());
        dataMap.set('params', new Y.Map());
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(node.id, nodeMap);
      }, origin);
    },
    [],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        if (updates.position) {
          let pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
          if (!(pos instanceof Y.Map)) {
            pos = new Y.Map();
            nodeMap.set('position', pos);
          }
          if (updates.position.x !== undefined) pos.set('x', updates.position.x);
          if (updates.position.y !== undefined) pos.set('y', updates.position.y);
        }

        const data = updates.data as Record<string, unknown> | undefined;
        if (data) {
          const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
          if (!(dataMap instanceof Y.Map)) return;

          if (data.name !== undefined) dataMap.set('name', data.name);
          if (data.content !== undefined) dataMap.set('content', data.content);
          if (data.coverUrl !== undefined) dataMap.set('coverUrl', data.coverUrl);
          if (data.state !== undefined) dataMap.set('state', data.state);
          if (data.runType !== undefined) dataMap.set('runType', data.runType);

          // Legacy compat — map nodeRuntimeData.parameter → params
          const nrd = data.nodeRuntimeData as Record<string, unknown> | undefined;
          if (nrd?.parameter !== undefined) {
            const params = dataMap.get('params') as Y.Map<unknown>;
            if (params instanceof Y.Map) {
              const paramObj = nrd.parameter as Record<string, unknown>;
              Object.entries(paramObj).forEach(([k, v]) => params.set(k, v));
            }
          }
        }
      }, origin);
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[], options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        for (const change of changes) {
          if (change.type === 'position' && change.position) {
            const nodeMap = mgr.nodesMap.get(change.id) as Y.Map<unknown> | undefined;
            if (!(nodeMap instanceof Y.Map)) continue;
            let pos = nodeMap.get('position') as Y.Map<unknown> | undefined;
            if (!(pos instanceof Y.Map)) {
              pos = new Y.Map();
              nodeMap.set('position', pos);
            }
            pos.set('x', change.position.x);
            pos.set('y', change.position.y);
          } else if (change.type === 'remove') {
            mgr.nodesMap.delete(change.id);
            mgr.edgesMap.forEach((edgeMap, edgeId) => {
              if (edgeMap instanceof Y.Map) {
                const src = edgeMap.get('source') as string;
                const tgt = edgeMap.get('target') as string;
                if (src === change.id || tgt === change.id) {
                  mgr.edgesMap.delete(edgeId);
                }
              }
            });
          }
          // 'select' / 'dimensions' / 'reset' — ReactFlow handles internally
        }
      }, origin);
    },
    [],
  );

  const setNodes = useCallback(
    (next: Node[], options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        mgr.nodesMap.forEach((_val, key) => mgr.nodesMap.delete(key));
        for (const node of next) {
          const nodeMap = new Y.Map();
          nodeMap.set('id', node.id);
          nodeMap.set('type', node.type ?? '1002');
          const pos = new Y.Map();
          pos.set('x', node.position?.x ?? 0);
          pos.set('y', node.position?.y ?? 0);
          nodeMap.set('position', pos);

          const dataMap = new Y.Map();
          dataMap.set('name', node.data?.name ?? '');
          dataMap.set('state', node.data?.state ?? 'idle');
          dataMap.set('content', node.data?.content ?? '');
          dataMap.set('prompt', new Y.XmlFragment());
          dataMap.set('attachments', new Y.Array());
          dataMap.set('params', new Y.Map());
          nodeMap.set('data', dataMap);

          mgr.nodesMap.set(node.id, nodeMap);
        }
      }, origin);
    },
    [],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      mgr.doc.transact(() => {
        for (const change of changes) {
          if (change.type === 'remove') {
            mgr.edgesMap.delete(change.id);
          }
        }
      }, userOrigin);
    },
    [],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const edgeId = `e-${connection.source}-${connection.sourceHandle ?? ''}-${connection.target}-${connection.targetHandle ?? ''}`;
      mgr.doc.transact(() => {
        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', connection.source);
        edgeMap.set('target', connection.target);
        if (connection.sourceHandle) edgeMap.set('sourceHandle', connection.sourceHandle);
        if (connection.targetHandle) edgeMap.set('targetHandle', connection.targetHandle);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, userOrigin);
    },
    [],
  );

  const setEdges = useCallback(
    (next: Edge[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      mgr.doc.transact(() => {
        mgr.edgesMap.forEach((_val, key) => mgr.edgesMap.delete(key));
        for (const edge of next) {
          const edgeMap = new Y.Map();
          edgeMap.set('id', edge.id);
          edgeMap.set('source', edge.source);
          edgeMap.set('target', edge.target);
          if (edge.sourceHandle) edgeMap.set('sourceHandle', edge.sourceHandle);
          if (edge.targetHandle) edgeMap.set('targetHandle', edge.targetHandle);
          mgr.edgesMap.set(edge.id, edgeMap);
        }
      }, userOrigin);
    },
    [],
  );

  /**
   * Update node generation params — uses noHistoryOrigin (not undo-tracked).
   * Params are configuration, not creative decisions.
   */
  const updateNodeParams = useCallback(
    (nodeId: string, params: Record<string, unknown>) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        const paramsMap = dataMap.get('params') as Y.Map<unknown>;
        if (paramsMap instanceof Y.Map) {
          Object.entries(params).forEach(([k, v]) => paramsMap.set(k, v));
        }
      }, noHistoryOrigin);
    },
    [],
  );

  const undo = useCallback(() => {
    const mgr = getCanvasYjsManager();
    if (!mgr || mgr.undoManager.undoStack.length === 0) return false;
    mgr.undoManager.undo();
    return true;
  }, []);

  const redo = useCallback(() => {
    const mgr = getCanvasYjsManager();
    if (!mgr || mgr.undoManager.redoStack.length === 0) return false;
    mgr.undoManager.redo();
    return true;
  }, []);

  return {
    addNode,
    updateNode,
    updateNodeParams,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setNodes,
    setEdges,
    undo,
    redo,
  };
}
