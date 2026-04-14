/**
 * Project canvas store hook.
 *
 * Reads nodes/edges from Redux (fed by the Yjs observe bridge in
 * `useCanvasYjs`). Write operations (addNode, updateNode, deleteNode,
 * onNodesChange, etc.) go directly to Yjs — the observe callback
 * syncs the result back to Redux for ReactFlow rendering.
 *
 * UI-only state (rightPanel, commentMode, etc.) stays in Redux and
 * is NOT synced to Yjs.
 */

import { useCallback } from 'react';
import * as Y from 'yjs';
import { useSelector, useDispatch, shallowEqual } from 'react-redux';
import type { RootState } from '@/store';
import { getCanvasYjsManager } from '@/utils/canvasYjsRef';
import { userOrigin, noHistoryOrigin } from '@/utils/yjsProjectManager';
import {
  setNodes,
  setEdges,
  setNodeTemplateData as setNodeTemplateDataAction,
  setWorkflowId as setWorkflowIdAction,
  openRightPanelAction,
  closeRightPanelAction,
  setAddResourceToInputRequestAction,
  setRightPanelAutoOpenResizableLeftPanelAction,
  openCanvasOverlayPanelAction,
  closeCanvasOverlayPanelAction,
  setCanvasCommentModeAction,
  openCanvasCommentComposerAction,
  closeCanvasCommentComposerAction,
} from '@/store/modules/canvas';
import type {
  CanvasNodeTemplateRow,
  CanvasCommentComposerState,
  CanvasOverlayPanelState,
  NewResultFlagItem,
  ResourceTypeForInput,
  RightPanelState,
} from '@/store/modules/canvas';
import type { NodeChange, EdgeChange, Connection, Node, Edge } from '@xyflow/react';

type HistoryOptions = { history?: 'default' | 'skip' };

// ── Redux selectors (unchanged) ─────────────────────────────────

const emptyNodes: Node[] = [];
const emptyEdges: Edge[] = [];
const emptyNewResultsFlag: NewResultFlagItem[] = [];
const emptyNodeTemplateData: CanvasNodeTemplateRow[] = [];
const selectNodes = (state: RootState) => state.canvas.nodes ?? emptyNodes;
const selectEdges = (state: RootState) => state.canvas.edges ?? emptyEdges;
const selectNodeTemplateData = (state: RootState) => state.canvas.nodeTemplateData ?? emptyNodeTemplateData;
const selectWorkflowId = (state: RootState) => state.canvas.workflowId;
const selectNewResultsFlag = (state: RootState) => state.canvas.newResultsFlag ?? emptyNewResultsFlag;
const defaultRightPanel: RightPanelState = {
  open: true,
  panelMode: 'node',
  panelType: 'page',
  autoOpenResizableLeftPanel: false,
};
const defaultCanvasOverlayPanel: CanvasOverlayPanelState = { open: false, nodeId: undefined };
const defaultCanvasCommentComposer: CanvasCommentComposerState = { open: false };
const selectRightPanel = (state: RootState) => state.canvas.rightPanel ?? defaultRightPanel;
const selectCanvasOverlayPanel = (state: RootState) => state.canvas.canvasOverlayPanel ?? defaultCanvasOverlayPanel;
const selectAddResourceToInputRequest = (state: RootState) => state.canvas.addResourceToInputRequest;
const selectCanvasCommentMode = (state: RootState) => state.canvas.commentMode ?? false;
const selectCanvasCommentComposer = (state: RootState) =>
  state.canvas.commentComposer ?? defaultCanvasCommentComposer;

// ── Yjs write helpers ───────────────────────────────────────────

function getOrigin(options?: HistoryOptions): string | symbol {
  return options?.history === 'skip' ? noHistoryOrigin : userOrigin;
}

export const useProjectStore = () => {
  const dispatch = useDispatch();

  // Read from Redux (fed by useCanvasYjs observe bridge).
  const nodes = useSelector(selectNodes, shallowEqual);
  const edges = useSelector(selectEdges, shallowEqual);
  const nodeTemplateData = useSelector(selectNodeTemplateData, shallowEqual);
  const workflowId = useSelector(selectWorkflowId);
  const newResultsFlag = useSelector(selectNewResultsFlag, shallowEqual);
  const rightPanel = useSelector(selectRightPanel, shallowEqual);
  const canvasOverlayPanel = useSelector(selectCanvasOverlayPanel, shallowEqual);
  const addResourceToInputRequest = useSelector(selectAddResourceToInputRequest);
  const canvasCommentMode = useSelector(selectCanvasCommentMode);
  const canvasCommentComposer = useSelector(selectCanvasCommentComposer, shallowEqual);

  // ── Node operations (write to Yjs) ──────────────────────────

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

          // Legacy backward compat — map nodeRuntimeData.parameter → params
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
      if (!mgr) {
        // Fallback: no Yjs yet, apply directly to Redux for local-only mode.
        // This shouldn't happen in production but handles the edge case.
        return;
      }

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
            // Also remove related edges
            mgr.edgesMap.forEach((edgeMap, edgeId) => {
              if (edgeMap instanceof Y.Map) {
                const src = edgeMap.get('source') as string;
                const tgt = edgeMap.get('target') as string;
                if (src === change.id || tgt === change.id) {
                  mgr.edgesMap.delete(edgeId);
                }
              }
            });
          } else if (change.type === 'select') {
            // Selection is local UI state. ReactFlow manages it internally
            // via its own state — we don't write it to Yjs.
            // Apply directly to Redux so ReactFlow sees the update.
            dispatch(setNodes(
              nodes.map(n => n.id === change.id ? { ...n, selected: change.selected } : n),
            ));
          }
          // 'dimensions' and 'reset' are local — skip.
        }
      }, origin);
    },
    [dispatch, nodes],
  );

  const setNodesAction = useCallback(
    (next: Node[], options?: HistoryOptions) => {
      // Bulk node replacement — used by import/paste operations.
      // Write each node to Yjs; the observe callback syncs back.
      const mgr = getCanvasYjsManager();
      if (!mgr) {
        dispatch(setNodes(next));
        return;
      }

      const origin = getOrigin(options);
      mgr.doc.transact(() => {
        // Clear existing
        mgr.nodesMap.forEach((_val, key) => mgr.nodesMap.delete(key));
        // Add new
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
    [dispatch],
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
          // 'select' is local UI state — handled by ReactFlow internally.
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

  const setEdgesAction = useCallback(
    (next: Edge[]) => {
      const mgr = getCanvasYjsManager();
      if (!mgr) {
        dispatch(setEdges(next));
        return;
      }

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
    [dispatch],
  );

  // ── Record helper (compat shim, currently a no-op) ──────────

  const record = useCallback((callback: () => void) => {
    callback();
  }, []);

  const initializeHistoryAction = useCallback(() => {}, []);

  // ── Non-Yjs Redux operations (UI state) ─────────────────────

  const setNodeTemplateData = useCallback(
    (data: CanvasNodeTemplateRow[]) => dispatch(setNodeTemplateDataAction(data)),
    [dispatch],
  );

  const addNewResultFlag = useCallback(
    (_nodeId: string, _type: 'generated' | 'exported' = 'generated') => {
      // newResultsFlag now lives in Yjs canvas map — skip Redux.
      // TODO: implement when new-results UI is wired.
    },
    [],
  );

  const removeNewResultFlag = useCallback((_nodeId: string) => {}, []);
  const setNewResultsFlag = useCallback((_flags: NewResultFlagItem[]) => {}, []);

  const setWorkflowId = useCallback(
    (wid: string) => dispatch(setWorkflowIdAction(wid)),
    [dispatch],
  );

  const openRightPanel = useCallback(
    (panelType: string, nodeId?: string, panelMode?: 'node' | 'assets', autoOpenResizableLeftPanel?: boolean) =>
      dispatch(openRightPanelAction({ panelType, nodeId, panelMode, autoOpenResizableLeftPanel })),
    [dispatch],
  );

  const closeRightPanel = useCallback(() => dispatch(closeRightPanelAction()), [dispatch]);

  const setRightPanelAutoOpenResizableLeftPanel = useCallback(
    (value: boolean) => dispatch(setRightPanelAutoOpenResizableLeftPanelAction(value)),
    [dispatch],
  );

  const openCanvasOverlayPanel = useCallback(
    (nodeId: string) => dispatch(openCanvasOverlayPanelAction({ nodeId })),
    [dispatch],
  );

  const closeCanvasOverlayPanel = useCallback(() => dispatch(closeCanvasOverlayPanelAction()), [dispatch]);

  const requestAddResourceToInput = useCallback(
    (payload: { url: string; name: string; type: ResourceTypeForInput }) =>
      dispatch(setAddResourceToInputRequestAction(payload)),
    [dispatch],
  );

  const clearAddResourceToInputRequest = useCallback(
    () => dispatch(setAddResourceToInputRequestAction(null)),
    [dispatch],
  );

  const setCanvasCommentMode = useCallback(
    (enabled: boolean) => dispatch(setCanvasCommentModeAction(enabled)),
    [dispatch],
  );

  const openCanvasCommentComposer = useCallback(
    (payload: { clientX: number; clientY: number; flowX: number; flowY: number }) =>
      dispatch(openCanvasCommentComposerAction(payload)),
    [dispatch],
  );

  const closeCanvasCommentComposer = useCallback(
    () => dispatch(closeCanvasCommentComposerAction()),
    [dispatch],
  );

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    record,
    addNode,
    setNodes: setNodesAction,
    setEdges: setEdgesAction,
    updateNode,
    initializeHistory: initializeHistoryAction,
    nodeTemplateData,
    setNodeTemplateData,
    newResultsFlag,
    addNewResultFlag,
    removeNewResultFlag,
    setNewResultsFlag,
    workflowId,
    setWorkflowId,
    rightPanel,
    canvasOverlayPanel,
    canvasCommentMode,
    canvasCommentComposer,
    openRightPanel,
    closeRightPanel,
    setRightPanelAutoOpenResizableLeftPanel,
    openCanvasOverlayPanel,
    closeCanvasOverlayPanel,
    addResourceToInputRequest,
    requestAddResourceToInput,
    clearAddResourceToInputRequest,
    setCanvasCommentMode,
    openCanvasCommentComposer,
    closeCanvasCommentComposer,
  };
};
