import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { nanoid } from 'nanoid';
import type {
  ImageEditorNodeDataPatch,
  ImageEditorRightSidePanelId,
} from '@/apps/project/components/mixedEditor/types';

export type ImageEditorActiveTool = 'select' | 'crop' | 'blank' | 'brush' | 'text';

/** User-starred images for the image editor Assets side panel (local Redux; not Yjs-synced). */
export interface ImageEditorFavoriteAsset {
  id: string;
  previewUrl: string;
  name?: string;
  /** Panel row that was starred (used so same URL on other rows does not all highlight). */
  sourcePanel?: ImageEditorRightSidePanelId;
  /** Stable row id in that panel (history node id, attach id, link uid, or favorite id for assets). */
  sourceItemId?: string;
}

/** Payload for {@link imageEditorSlice.actions.toggleImageEditorFavoriteAsset}. */
export type ToggleImageEditorFavoritePayload = {
  panel: ImageEditorRightSidePanelId;
  item: { id: string; previewUrl: string; name?: string };
};

export interface ImageEditorState {
  nodes: Node[];
  edges: Edge[];
  activeTool: ImageEditorActiveTool;
  expandViewportLocks: Record<string, true>;
  favoriteAssets: ImageEditorFavoriteAsset[];
}

const initialState: ImageEditorState = {
  nodes: [],
  edges: [],
  activeTool: 'select',
  expandViewportLocks: {},
  favoriteAssets: [],
};

const imageEditorSlice = createSlice({
  name: 'imageEditor',
  initialState,
  reducers: {
    resetImageEditor: () => ({ ...initialState }),
    resetImageEditorNodes: (state) => {
      state.nodes = [];
    },
    setImageEditorNodes: (state, action: PayloadAction<Node[]>) => {
      state.nodes = action.payload;
    },
    applyImageEditorNodeChanges: (state, action: PayloadAction<NodeChange[]>) => {
      state.nodes ??= [];
      state.nodes = applyNodeChanges(action.payload, state.nodes);
    },
    addImageEditorNode: (state, action: PayloadAction<{ node: Node; select?: boolean }>) => {
      const { node, select = true } = action.payload;
      for (const n of state.nodes) n.selected = false;
      const newNode: Node = { ...node, selected: select };
      const i = state.nodes.findIndex((n) => n.id === node.id);
      if (i !== -1) state.nodes[i] = newNode;
      else state.nodes.push(newNode);
    },
    updateImageEditorNode: (state, action: PayloadAction<{ nodeId: string; updates: Partial<Node> }>) => {
      const { nodeId, updates } = action.payload;
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const { data: updatesData, style: updatesStyle, ...rest } = updates;
      Object.assign(node, rest);
      if (updatesStyle !== undefined) {
        node.style = { ...(node.style as object), ...(updatesStyle as object) };
      }
      if (updatesData !== undefined) {
        const nodeData = node.data as Record<string, unknown>;
        for (const [key, val] of Object.entries(updatesData as Record<string, unknown>)) {
          if (key === 'pickState') {
            if (val === null || val === undefined) delete nodeData.pickState;
            else nodeData.pickState = { ...((nodeData.pickState ?? {}) as object), ...(val as object) };
          } else {
            nodeData[key] = val;
          }
        }
      }
    },
    appendImageEditorNodes: (state, action: PayloadAction<Node[]>) => {
      state.nodes.push(...action.payload);
    },
    patchImageEditorNodeData: (state, action: PayloadAction<{ nodeId: string; patch: ImageEditorNodeDataPatch }>) => {
      const { nodeId, patch } = action.payload;
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const nodeData = node.data as Record<string, unknown>;
      for (const [key, val] of Object.entries(patch as Record<string, unknown>)) {
        if (key === 'pickState') {
          if (val === null || val === undefined) delete nodeData.pickState;
          else nodeData.pickState = { ...((nodeData.pickState ?? {}) as object), ...(val as object) };
        } else {
          nodeData[key] = val;
        }
      }
    },
    removeImageEditorNode: (state, action: PayloadAction<string>) => {
      state.nodes ??= [];
      state.nodes = state.nodes.filter((n) => n.id !== action.payload);
    },
    resetImageEditorEdges: (state) => {
      state.edges = [];
    },
    setImageEditorEdges: (state, action: PayloadAction<Edge[]>) => {
      state.edges = action.payload;
    },
    syncImageEditorFromYjs: (
      state,
      action: PayloadAction<{
        nodes?: Node[];
        edges?: Edge[];
        activeTool?: ImageEditorActiveTool;
        expandViewportLocks?: Record<string, true>;
      }>,
    ) => {
      const { nodes, edges, activeTool, expandViewportLocks } = action.payload;
      if (nodes !== undefined) state.nodes = nodes;
      if (edges !== undefined) state.edges = edges;
      if (activeTool !== undefined) state.activeTool = activeTool;
      if (expandViewportLocks !== undefined) state.expandViewportLocks = expandViewportLocks;
    },
    applyImageEditorEdgeChanges: (state, action: PayloadAction<EdgeChange[]>) => {
      state.edges ??= [];
      state.edges = applyEdgeChanges(action.payload, state.edges);
    },
    addImageEditorEdge: (state, action: PayloadAction<Connection>) => {
      state.edges ??= [];
      state.edges = addEdge({ ...action.payload, type: 'default' }, state.edges);
    },
    setImageEditorActiveTool: (state, action: PayloadAction<ImageEditorActiveTool>) => {
      state.activeTool = action.payload;
    },
    setImageEditorExpandViewportLock: (
      state,
      action: PayloadAction<{ nodeId: string; locked: boolean }>,
    ) => {
      state.expandViewportLocks ??= {};
      const { nodeId, locked } = action.payload;
      if (locked) state.expandViewportLocks[nodeId] = true;
      else delete state.expandViewportLocks[nodeId];
    },
    clearImageEditorExpandLock: (state, action: PayloadAction<string>) => {
      state.expandViewportLocks ??= {};
      delete state.expandViewportLocks[action.payload];
    },
    pruneImageEditorExpandLocks: (state, action: PayloadAction<string[]>) => {
      state.expandViewportLocks ??= {};
      const keep = new Set(action.payload);
      for (const k of Object.keys(state.expandViewportLocks)) {
        if (!keep.has(k)) delete state.expandViewportLocks[k];
      }
    },
    /**
     * Adds or removes a favorite for one side-panel row (`panel` + `item.id`), not URL-global.
     *
     * @param action.payload.panel - Which list the row belongs to (`assets` removes by favorite `item.id`)
     * @param action.payload.item - Row identity + media fields
     */
    toggleImageEditorFavoriteAsset: (state, action: PayloadAction<ToggleImageEditorFavoritePayload>) => {
      const { panel, item } = action.payload;
      const url = item.previewUrl.trim();
      if (!url) return;
      state.favoriteAssets ??= [];

      if (panel === 'assets') {
        const i = state.favoriteAssets.findIndex((f) => f.id === item.id);
        if (i !== -1) state.favoriteAssets.splice(i, 1);
        return;
      }

      const i = state.favoriteAssets.findIndex(
        (f) => f.sourcePanel === panel && f.sourceItemId === item.id,
      );
      if (i !== -1) {
        state.favoriteAssets.splice(i, 1);
        return;
      }

      const trimmedName = item.name?.trim();
      state.favoriteAssets.push({
        id: `fav-${nanoid(10)}`,
        previewUrl: url,
        ...(trimmedName ? { name: trimmedName } : {}),
        sourcePanel: panel,
        sourceItemId: item.id,
      });
    },
  },
});

export const {
  resetImageEditor,
  resetImageEditorNodes,
  setImageEditorNodes,
  applyImageEditorNodeChanges,
  addImageEditorNode,
  updateImageEditorNode,
  appendImageEditorNodes,
  patchImageEditorNodeData,
  removeImageEditorNode,
  resetImageEditorEdges,
  setImageEditorEdges,
  syncImageEditorFromYjs,
  applyImageEditorEdgeChanges,
  addImageEditorEdge,
  setImageEditorActiveTool,
  setImageEditorExpandViewportLock,
  clearImageEditorExpandLock,
  pruneImageEditorExpandLocks,
  toggleImageEditorFavoriteAsset,
} = imageEditorSlice.actions;

export default imageEditorSlice.reducer;
