/**
 * Canvas write operations — all writes go directly to Yjs.
 *
 * Sibling hooks/contexts:
 * - `useCanvasData` — read nodes/edges/toasts (Context)
 * - **useCanvasActions** — write nodes/edges (Yjs)
 * - `useCanvasUI` (CanvasUIContext) — canvas-only UI state
 *   (overlay panel, comment mode)
 * - `useProjectLayout` (ProjectLayoutContext) — project page right
 *   editor panel state (cross-Space)
 */

import { useCallback, useRef } from 'react';
import * as Y from 'yjs';
import {
  getUserOrigin,
  noHistoryOrigin,
} from '@/data/yjs/canvas-space';
import type { CanvasSpaceManager } from '@/data/yjs/canvas-space';
import { useActiveCanvasSpace } from '@/domain/space/ActiveCanvasSpaceContext';
import type { NodeChange, EdgeChange, Connection, Node, Edge } from '@xyflow/react';
import type { NodeState, HandlingActor, CanvasNodeFields, AttachRef } from '@breatic/shared';

type HistoryOptions = { history?: 'default' | 'skip' };

function getOrigin(options?: HistoryOptions): string | symbol {
  return options?.history === 'skip' ? noHistoryOrigin : getUserOrigin();
}

export function useCanvasActions() {
  // The active canvas Space manager comes from the page-level
  // `ActiveCanvasSpaceProvider`. We pin it on a ref so the
  // useCallback bodies below can keep their `[]` dep arrays — they
  // read `activeMgrRef.current` at call time and pick up the latest
  // manager identity automatically when the user switches Spaces.
  const activeMgr = useActiveCanvasSpace();
  const activeMgrRef = useRef<CanvasSpaceManager | null>(activeMgr);
  activeMgrRef.current = activeMgr;
  const getCanvasYjsManager = (): CanvasSpaceManager | null =>
    activeMgrRef.current;

  const addNode = useCallback(
    (node: Node, options?: { select?: boolean } & HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

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
        // Canvas-native schema: state machine, no history array
        dataMap.set('state', (node.data?.state as string) ?? 'idle');
        dataMap.set('attachments', new Y.Array());
        // Generative nodes may have a rich text prompt fragment
        if (node.data?.prompt !== undefined && node.data.prompt !== null) {
          dataMap.set('prompt', node.data.prompt);
        }
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(node.id, nodeMap);
      }, origin);
    },
    [],
  );

  const updateNode = useCallback(
    (nodeId: string, updates: Partial<Node>, options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

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
          // pickState: canvas-pick-mode state stored in Yjs so collaborators
          // can observe pick mode activation. Not part of the history schema but
          // kept as a transient coordination signal.
          if ('pickState' in data) dataMap.set('pickState', data.pickState ?? null);
          // Do not persist old fields (state/content/coverUrl/runType) which are removed.
        }
      }, origin);
    },
    [],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[], options?: HistoryOptions) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

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
      if (!mgr?.synced) return;

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
          // Canvas-native schema: state machine, no history array
          dataMap.set('state', (node.data?.state as string) ?? 'idle');
          dataMap.set('attachments', new Y.Array());
          if (node.data?.prompt !== undefined && node.data.prompt !== null) {
            dataMap.set('prompt', node.data.prompt);
          }
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
      if (!mgr?.synced) return;

      mgr.doc.transact(() => {
        for (const change of changes) {
          if (change.type === 'remove') {
            mgr.edgesMap.delete(change.id);
          }
        }
      }, getUserOrigin());
    },
    [],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const edgeId = `e-${connection.source}-${connection.sourceHandle ?? ''}-${connection.target}-${connection.targetHandle ?? ''}`;
      mgr.doc.transact(() => {
        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', connection.source);
        edgeMap.set('target', connection.target);
        if (connection.sourceHandle) edgeMap.set('sourceHandle', connection.sourceHandle);
        if (connection.targetHandle) edgeMap.set('targetHandle', connection.targetHandle);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, getUserOrigin());
    },
    [],
  );

  const setEdges = useCallback(
    (next: Edge[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

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
      }, getUserOrigin());
    },
    [],
  );

  /**
   * Write `content` (and optional dimension fields) directly into a node's data Y.Map.
   *
   * Used by local upload flows (image/video/audio nodes) to set the result URL
   * in the canvas-native schema (no history indirection).
   *
   * Not undo-tracked (idempotent last-write-wins).
   *
   * @param nodeId - Canvas node to update.
   * @param fields - content URL and optional width/height/duration/cover_url.
   */
  const setNodeContent = useCallback(
    (nodeId: string, fields: {
      content: string;
      cover_url?: string;
      width?: number;
      height?: number;
      duration?: number;
    }) => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('content', fields.content);
        if (fields.cover_url !== undefined) dataMap.set('cover_url', fields.cover_url);
        if (fields.width !== undefined) dataMap.set('width', fields.width);
        if (fields.height !== undefined) dataMap.set('height', fields.height);
        if (fields.duration !== undefined) dataMap.set('duration', fields.duration);
      }, noHistoryOrigin);
    },
    [],
  );

  /**
   * Create a data node (image/video/audio/text/etc.) in `nodesMap`.
   *
   * Frontend is the only actor that creates nodes (universal rule).
   * Backend can only modify `state` / content fields via the event bus.
   *
   * @param opts.type - ReactFlow node type string (e.g. '1002' for image).
   * @param opts.sourceNodeId - Parent node id when produced by mini-tool.
   * @param opts.position - Canvas coordinates (defaults to 0,0).
   * @param opts.data - Optional partial data fields to seed (content, name, etc.).
   * @returns The new node's UUID v4 id.
   */
  const createDataNode = useCallback(
    (opts: {
      type: string;
      sourceNodeId?: string;
      position?: { x: number; y: number };
      data?: Partial<CanvasNodeFields['data']>;
    }): string => {
      const mgr = getCanvasYjsManager();
      const nodeId = crypto.randomUUID();
      if (!mgr?.synced) return nodeId;

      mgr.doc.transact(() => {
        const nodeMap = new Y.Map();
        nodeMap.set('id', nodeId);
        nodeMap.set('type', opts.type);
        const pos = new Y.Map();
        pos.set('x', opts.position?.x ?? 0);
        pos.set('y', opts.position?.y ?? 0);
        nodeMap.set('position', pos);

        const dataMap = new Y.Map();
        dataMap.set('name', opts.data?.name ?? '');
        dataMap.set('state', 'idle');
        dataMap.set('attachments', new Y.Array<AttachRef>());
        if (opts.data?.content !== undefined) dataMap.set('content', opts.data.content);
        if (opts.data?.cover_url !== undefined) dataMap.set('cover_url', opts.data.cover_url);
        if (opts.data?.width !== undefined) dataMap.set('width', opts.data.width);
        if (opts.data?.height !== undefined) dataMap.set('height', opts.data.height);
        if (opts.data?.duration !== undefined) dataMap.set('duration', opts.data.duration);
        if (opts.sourceNodeId !== undefined) dataMap.set('sourceNodeId', opts.sourceNodeId);
        if (opts.data?.operation !== undefined) dataMap.set('operation', opts.data.operation);
        if (opts.data?.operationParams !== undefined) dataMap.set('operationParams', opts.data.operationParams);
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(nodeId, nodeMap);
      }, getUserOrigin());

      return nodeId;
    },
    [],
  );

  /**
   * Create a generative node (prompt + model + params, no content).
   *
   * Generative nodes are always `idle` — executing is a local button loading state (UX only).
   * Each execute click produces a new data node child.
   *
   * @param opts.prompt - Optional initial prompt text (stored in the data field).
   * @param opts.model - Model id from config/models/*.yaml.
   * @param opts.modelParams - Model-specific params.
   * @param opts.position - Canvas coordinates (defaults to 0,0).
   * @returns The new node's UUID v4 id.
   */
  const createGenerativeNode = useCallback(
    (opts: {
      prompt?: string;
      model?: string;
      modelParams?: Record<string, unknown>;
      position?: { x: number; y: number };
    }): string => {
      const mgr = getCanvasYjsManager();
      const nodeId = crypto.randomUUID();
      if (!mgr?.synced) return nodeId;

      mgr.doc.transact(() => {
        const nodeMap = new Y.Map();
        nodeMap.set('id', nodeId);
        nodeMap.set('type', 'generative');
        const pos = new Y.Map();
        pos.set('x', opts.position?.x ?? 0);
        pos.set('y', opts.position?.y ?? 0);
        nodeMap.set('position', pos);

        const dataMap = new Y.Map();
        dataMap.set('name', '');
        dataMap.set('state', 'idle');
        dataMap.set('attachments', new Y.Array<AttachRef>());
        // Generative node prompt is a Y.XmlFragment for TipTap rich text
        dataMap.set('prompt', new Y.XmlFragment());
        if (opts.model !== undefined) dataMap.set('model', opts.model);
        if (opts.modelParams !== undefined) dataMap.set('modelParams', opts.modelParams);
        nodeMap.set('data', dataMap);

        mgr.nodesMap.set(nodeId, nodeMap);
      }, getUserOrigin());

      return nodeId;
    },
    [],
  );

  /**
   * Create an edge between two nodes in `edgesMap`.
   *
   * @param opts.sourceNodeId - Source node id.
   * @param opts.targetNodeId - Target node id.
   * @param opts.label - Optional display label.
   * @returns The new edge's id.
   */
  const createEdge = useCallback(
    (opts: {
      sourceNodeId: string;
      targetNodeId: string;
      label?: string;
    }): string => {
      const mgr = getCanvasYjsManager();
      const edgeId = `e-${opts.sourceNodeId}-${opts.targetNodeId}-${crypto.randomUUID().slice(0, 8)}`;
      if (!mgr?.synced) return edgeId;

      mgr.doc.transact(() => {
        const edgeMap = new Y.Map();
        edgeMap.set('id', edgeId);
        edgeMap.set('source', opts.sourceNodeId);
        edgeMap.set('target', opts.targetNodeId);
        if (opts.label !== undefined) edgeMap.set('label', opts.label);
        mgr.edgesMap.set(edgeId, edgeMap);
      }, getUserOrigin());

      return edgeId;
    },
    [],
  );

  /**
   * Delete a node and all edges referencing it from `nodesMap` / `edgesMap`.
   *
   * Per spec: throws when the node's state is `'handling'` to prevent
   * data loss from racing delete + completion.
   *
   * @param nodeId - Node to delete.
   * @throws Error when node state is 'handling'.
   */
  const deleteNodeAndEdges = useCallback(
    (nodeId: string): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (nodeMap instanceof Y.Map) {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (dataMap instanceof Y.Map) {
          const state = dataMap.get('state') as string | undefined;
          if (state === 'handling') {
            throw new Error(`Cannot delete node ${nodeId}: node is currently handling.`);
          }
        }
      }

      mgr.doc.transact(() => {
        mgr.nodesMap.delete(nodeId);
        mgr.edgesMap.forEach((edgeMap, edgeId) => {
          if (edgeMap instanceof Y.Map) {
            const src = edgeMap.get('source') as string;
            const tgt = edgeMap.get('target') as string;
            if (src === nodeId || tgt === nodeId) {
              mgr.edgesMap.delete(edgeId);
            }
          }
        });
      }, getUserOrigin());
    },
    [],
  );

  /**
   * Transition a node's state in Yjs.
   *
   * Used by frontend when a POST returns 202+task_id — transition from
   * localPending to 'handling' in Yjs so collaborators can observe.
   *
   * @param nodeId - Target node.
   * @param state - New Yjs-shared state.
   * @param handlingBy - Required when state === 'handling'; identifies the actor.
   */
  const setNodeState = useCallback(
    (nodeId: string, state: NodeState, handlingBy?: HandlingActor): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('state', state);
        if (state === 'handling' && handlingBy) {
          dataMap.set('handlingBy', handlingBy);
          dataMap.delete('errorMessage'); // clear previous error on new attempt
        } else if (state === 'idle') {
          dataMap.delete('handlingBy');
        }
      }, noHistoryOrigin);
    },
    [],
  );

  /**
   * Set an error message on a node (state stays 'idle', error is visible to all).
   *
   * Backend-failed nodes: visible to all collaborators, deletable by anyone.
   * Typically applied by the collab consumer via the event bus; exposed here
   * for frontend error propagation edge cases (e.g., retry UX before POST).
   *
   * @param nodeId - Target node.
   * @param errorMessage - Human-readable error description.
   */
  const setNodeError = useCallback(
    (nodeId: string, errorMessage: string): void => {
      const mgr = getCanvasYjsManager();
      if (!mgr?.synced) return;

      const nodeMap = mgr.nodesMap.get(nodeId) as Y.Map<unknown> | undefined;
      if (!(nodeMap instanceof Y.Map)) return;

      mgr.doc.transact(() => {
        const dataMap = nodeMap.get('data') as Y.Map<unknown> | undefined;
        if (!(dataMap instanceof Y.Map)) return;
        dataMap.set('state', 'idle');
        dataMap.set('errorMessage', errorMessage);
        dataMap.delete('handlingBy');
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
    onNodesChange,
    onEdgesChange,
    onConnect,
    setNodes,
    setEdges,
    undo,
    redo,
    // Canvas-native schema helpers
    setNodeContent,
    createDataNode,
    createGenerativeNode,
    createEdge,
    deleteNodeAndEdges,
    setNodeState,
    setNodeError,
  };
}
