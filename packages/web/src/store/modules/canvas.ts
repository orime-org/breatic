/**
 * Canvas UI state slice.
 *
 * Only contains UI-only state that is NOT synced to Yjs.
 * Canvas nodes/edges live in CanvasDataContext (via Yjs observe).
 */
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface RightPanelState {
  open: boolean;
  panelType?: string;
  nodeId?: string;
  panelMode?: 'node' | 'assets';
  autoOpenResizableLeftPanel?: boolean;
}

export type ResourceTypeForInput = 'image' | 'file' | 'text' | 'audio' | 'video';
export interface AddResourceToInputRequest {
  url: string;
  name: string;
  type: ResourceTypeForInput;
}

export interface CanvasOverlayPanelState {
  open: boolean;
  nodeId?: string;
}

export interface CanvasCommentComposerState {
  open: boolean;
  clientX?: number;
  clientY?: number;
  flowX?: number;
  flowY?: number;
}

/** Palette row: API shape or built-in defaults (`template_type` for library UI). */
export type CanvasNodeTemplateRow = {
  template_code?: number;
  template_type?: string;
  template_name?: string;
  template_icon?: string;
  content?: { models?: unknown };
};

export interface CanvasState {
  nodeTemplateData: CanvasNodeTemplateRow[];
  workflowId: string;
  rightPanel: RightPanelState;
  canvasOverlayPanel: CanvasOverlayPanelState;
  addResourceToInputRequest: AddResourceToInputRequest | null;
  commentMode: boolean;
  commentComposer: CanvasCommentComposerState;
}

const initialRightPanel: RightPanelState = {
  open: true,
  panelMode: 'node',
  panelType: 'page',
  autoOpenResizableLeftPanel: false,
};

const initialState: CanvasState = {
  nodeTemplateData: [],
  workflowId: '',
  rightPanel: initialRightPanel,
  canvasOverlayPanel: { open: false, nodeId: undefined },
  addResourceToInputRequest: null,
  commentMode: false,
  commentComposer: { open: false },
};

const canvasSlice = createSlice({
  name: 'canvas',
  initialState,
  reducers: {
    setNodeTemplateData: (state, action: PayloadAction<CanvasNodeTemplateRow[]>) => {
      state.nodeTemplateData = action.payload;
    },
    setWorkflowId: (state, action: PayloadAction<string>) => {
      state.workflowId = action.payload;
    },
    openRightPanel: (
      state,
      action: PayloadAction<{
        panelType: string;
        nodeId?: string;
        panelMode?: 'node' | 'assets';
        autoOpenResizableLeftPanel?: boolean;
      }>,
    ) => {
      const { panelType, nodeId, panelMode, autoOpenResizableLeftPanel } = action.payload;
      state.rightPanel = {
        open: true,
        panelType,
        nodeId,
        panelMode: panelMode ?? 'node',
        autoOpenResizableLeftPanel: !!autoOpenResizableLeftPanel,
      };
    },
    closeRightPanel: (state) => {
      state.rightPanel.open = false;
      state.rightPanel.autoOpenResizableLeftPanel = false;
    },
    setRightPanelAutoOpenResizableLeftPanel: (state, action: PayloadAction<boolean>) => {
      state.rightPanel.autoOpenResizableLeftPanel = action.payload;
    },
    openCanvasOverlayPanel: (state, action: PayloadAction<{ nodeId: string }>) => {
      state.canvasOverlayPanel = { open: true, nodeId: action.payload.nodeId };
    },
    closeCanvasOverlayPanel: (state) => {
      state.canvasOverlayPanel = { open: false, nodeId: undefined };
    },
    setAddResourceToInputRequest: (state, action: PayloadAction<AddResourceToInputRequest | null>) => {
      state.addResourceToInputRequest = action.payload;
    },
    setCanvasCommentMode: (state, action: PayloadAction<boolean>) => {
      state.commentMode = action.payload;
      if (!action.payload) {
        state.commentComposer = { open: false };
      }
    },
    openCanvasCommentComposer: (
      state,
      action: PayloadAction<{ clientX: number; clientY: number; flowX: number; flowY: number }>,
    ) => {
      state.commentComposer = { open: true, ...action.payload };
    },
    closeCanvasCommentComposer: (state) => {
      state.commentComposer = { open: false };
    },
  },
});

export const {
  setNodeTemplateData,
  setWorkflowId,
  openRightPanel: openRightPanelAction,
  closeRightPanel: closeRightPanelAction,
  setRightPanelAutoOpenResizableLeftPanel: setRightPanelAutoOpenResizableLeftPanelAction,
  openCanvasOverlayPanel: openCanvasOverlayPanelAction,
  closeCanvasOverlayPanel: closeCanvasOverlayPanelAction,
  setAddResourceToInputRequest: setAddResourceToInputRequestAction,
  setCanvasCommentMode: setCanvasCommentModeAction,
  openCanvasCommentComposer: openCanvasCommentComposerAction,
  closeCanvasCommentComposer: closeCanvasCommentComposerAction,
} = canvasSlice.actions;

export default canvasSlice.reducer;
