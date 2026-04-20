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

export type MixedEditorActiveTool = 'select' | 'crop' | 'blank' | 'brush' | 'text';

/** User-starred images for the mixed editor Assets side panel (local Redux; not Yjs-synced). */
export interface MixedEditorFavoriteAsset {
  id: string;
  previewUrl: string;
  name?: string;
  /** Panel row that was starred (used so same URL on other rows does not all highlight). */
  sourcePanel?: ImageEditorRightSidePanelId;
  /** Stable row id in that panel (history node id, attach id, link uid, or favorite id for assets). */
  sourceItemId?: string;
}

/** Payload for {@link mixedEditorSlice.actions.toggleMixedEditorFavoriteAsset}. */
export type ToggleMixedEditorFavoritePayload = {
  panel: ImageEditorRightSidePanelId;
  item: { id: string; previewUrl: string; name?: string };
};

export interface MixedEditorState {
  nodes: Node[];
  edges: Edge[];
  activeTool: MixedEditorActiveTool;
  expandViewportLocks: Record<string, true>;
  favoriteAssets: MixedEditorFavoriteAsset[];
}

const initialState: MixedEditorState = {
  nodes: [],
  edges: [],
  activeTool: 'select',
  expandViewportLocks: {},
  favoriteAssets: [],
};

const mixedEditorSlice = createSlice({
  name: 'mixedEditor',
  initialState,
  reducers: {
    resetMixedEditor: () => ({ ...initialState }),
    resetMixedEditorNodes: (state) => {
      state.nodes = [];
    },
    setMixedEditorNodes: (state, action: PayloadAction<Node[]>) => {
      state.nodes = action.payload;
    },
    applyMixedEditorNodeChanges: (state, action: PayloadAction<NodeChange[]>) => {
      state.nodes ??= [];
      state.nodes = applyNodeChanges(action.payload, state.nodes);
    },
    addMixedEditorNode: (state, action: PayloadAction<{ node: Node; select?: boolean }>) => {
      const { node, select = true } = action.payload;
      for (const n of state.nodes) n.selected = false;
      const newNode: Node = { ...node, selected: select };
      const i = state.nodes.findIndex((n) => n.id === node.id);
      if (i !== -1) state.nodes[i] = newNode;
      else state.nodes.push(newNode);
    },
    updateMixedEditorNode: (state, action: PayloadAction<{ nodeId: string; updates: Partial<Node> }>) => {
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
    appendMixedEditorNodes: (state, action: PayloadAction<Node[]>) => {
      state.nodes.push(...action.payload);
    },
    patchMixedEditorNodeData: (state, action: PayloadAction<{ nodeId: string; patch: ImageEditorNodeDataPatch }>) => {
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
    removeMixedEditorNode: (state, action: PayloadAction<string>) => {
      state.nodes ??= [];
      state.nodes = state.nodes.filter((n) => n.id !== action.payload);
    },
    resetMixedEditorEdges: (state) => {
      state.edges = [];
    },
    setMixedEditorEdges: (state, action: PayloadAction<Edge[]>) => {
      state.edges = action.payload;
    },
    syncMixedEditorFromYjs: (
      state,
      action: PayloadAction<{
        nodes?: Node[];
        edges?: Edge[];
        activeTool?: MixedEditorActiveTool;
        expandViewportLocks?: Record<string, true>;
      }>,
    ) => {
      const { nodes, edges, activeTool, expandViewportLocks } = action.payload;
      if (nodes !== undefined) state.nodes = nodes;
      if (edges !== undefined) state.edges = edges;
      if (activeTool !== undefined) state.activeTool = activeTool;
      if (expandViewportLocks !== undefined) state.expandViewportLocks = expandViewportLocks;
    },
    applyMixedEditorEdgeChanges: (state, action: PayloadAction<EdgeChange[]>) => {
      state.edges ??= [];
      state.edges = applyEdgeChanges(action.payload, state.edges);
    },
    addMixedEditorEdge: (state, action: PayloadAction<Connection>) => {
      state.edges ??= [];
      state.edges = addEdge({ ...action.payload, type: 'default' }, state.edges);
    },
    setMixedEditorActiveTool: (state, action: PayloadAction<MixedEditorActiveTool>) => {
      state.activeTool = action.payload;
    },
    setMixedEditorExpandViewportLock: (
      state,
      action: PayloadAction<{ nodeId: string; locked: boolean }>,
    ) => {
      state.expandViewportLocks ??= {};
      const { nodeId, locked } = action.payload;
      if (locked) state.expandViewportLocks[nodeId] = true;
      else delete state.expandViewportLocks[nodeId];
    },
    clearMixedEditorExpandLock: (state, action: PayloadAction<string>) => {
      state.expandViewportLocks ??= {};
      delete state.expandViewportLocks[action.payload];
    },
    pruneMixedEditorExpandLocks: (state, action: PayloadAction<string[]>) => {
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
    toggleMixedEditorFavoriteAsset: (state, action: PayloadAction<ToggleMixedEditorFavoritePayload>) => {
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
  resetMixedEditor,
  resetMixedEditorNodes,
  setMixedEditorNodes,
  applyMixedEditorNodeChanges,
  addMixedEditorNode,
  updateMixedEditorNode,
  appendMixedEditorNodes,
  patchMixedEditorNodeData,
  removeMixedEditorNode,
  resetMixedEditorEdges,
  setMixedEditorEdges,
  syncMixedEditorFromYjs,
  applyMixedEditorEdgeChanges,
  addMixedEditorEdge,
  setMixedEditorActiveTool,
  setMixedEditorExpandViewportLock,
  clearMixedEditorExpandLock,
  pruneMixedEditorExpandLocks,
  toggleMixedEditorFavoriteAsset,
} = mixedEditorSlice.actions;

export default mixedEditorSlice.reducer;
