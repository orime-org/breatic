/**
 * Canvas UI state — reads/writes Redux for UI-only state that is
 * NOT synced to Yjs.
 *
 * Part of the three-hook split:
 * - {@link useCanvasData} — read nodes/edges/toasts (Context)
 * - {@link useCanvasActions} — write nodes/edges (Yjs)
 * - **useCanvasUI** — read/write UI state (Redux)
 */

import { useCallback } from 'react';
import { useSelector, useDispatch, shallowEqual } from 'react-redux';
import type { RootState } from '@/store';
import {
  setNodeTemplateData as setNodeTemplateDataAction,
  setWorkflowId as setWorkflowIdAction,
  openRightPanelAction,
  closeRightPanelAction,
  setRightPanelAutoOpenResizableLeftPanelAction,
  openCanvasOverlayPanelAction,
  closeCanvasOverlayPanelAction,
  setAddResourceToInputRequestAction,
  setCanvasCommentModeAction,
  openCanvasCommentComposerAction,
  closeCanvasCommentComposerAction,
  type CanvasNodeTemplateRow,
  type CanvasCommentComposerState,
  type CanvasOverlayPanelState,
  type RightPanelState,
  type ResourceTypeForInput,
} from '@/store/modules/canvas';

// ── Selectors ──────────────────────────────────────────────────

const emptyNodeTemplateData: CanvasNodeTemplateRow[] = [];
const defaultRightPanel: RightPanelState = {
  open: true,
  panelMode: 'node',
  panelType: 'page',
  autoOpenResizableLeftPanel: false,
};
const defaultCanvasOverlayPanel: CanvasOverlayPanelState = { open: false, nodeId: undefined };
const defaultCanvasCommentComposer: CanvasCommentComposerState = { open: false };

const selectNodeTemplateData = (state: RootState) => state.canvas.nodeTemplateData ?? emptyNodeTemplateData;
const selectWorkflowId = (state: RootState) => state.canvas.workflowId;
const selectRightPanel = (state: RootState) => state.canvas.rightPanel ?? defaultRightPanel;
const selectCanvasOverlayPanel = (state: RootState) => state.canvas.canvasOverlayPanel ?? defaultCanvasOverlayPanel;
const selectAddResourceToInputRequest = (state: RootState) => state.canvas.addResourceToInputRequest;
const selectCanvasCommentMode = (state: RootState) => state.canvas.commentMode ?? false;
const selectCanvasCommentComposer = (state: RootState) =>
  state.canvas.commentComposer ?? defaultCanvasCommentComposer;

// ── Hook ───────────────────────────────────────────────────────

export function useCanvasUI() {
  const dispatch = useDispatch();

  const nodeTemplateData = useSelector(selectNodeTemplateData, shallowEqual);
  const workflowId = useSelector(selectWorkflowId);
  const rightPanel = useSelector(selectRightPanel, shallowEqual);
  const canvasOverlayPanel = useSelector(selectCanvasOverlayPanel, shallowEqual);
  const addResourceToInputRequest = useSelector(selectAddResourceToInputRequest);
  const canvasCommentMode = useSelector(selectCanvasCommentMode);
  const canvasCommentComposer = useSelector(selectCanvasCommentComposer, shallowEqual);

  const setNodeTemplateData = useCallback(
    (data: CanvasNodeTemplateRow[]) => dispatch(setNodeTemplateDataAction(data)),
    [dispatch],
  );

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
    nodeTemplateData,
    setNodeTemplateData,
    workflowId,
    setWorkflowId,
    rightPanel,
    openRightPanel,
    closeRightPanel,
    setRightPanelAutoOpenResizableLeftPanel,
    canvasOverlayPanel,
    openCanvasOverlayPanel,
    closeCanvasOverlayPanel,
    addResourceToInputRequest,
    requestAddResourceToInput,
    clearAddResourceToInputRequest,
    canvasCommentMode,
    setCanvasCommentMode,
    canvasCommentComposer,
    openCanvasCommentComposer,
    closeCanvasCommentComposer,
  };
}
