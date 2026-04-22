/**
 * Mixed editor Redux slice — UI-only state.
 *
 * Data (`nodes`, `edges`) now lives in the per-node Yjs editor doc and
 * is consumed via {@link MixedEditorDataContext}. Redux keeps only the
 * non-replicated per-user UI state:
 *
 *   - `activeTool`          — toolbar mode (select / crop / brush / ...)
 *   - `expandViewportLocks` — per-node "expand locks the viewport"
 *                             interaction mode
 *   - `favoriteAssets`      — user's starred side-panel assets
 *
 * All these are local to each collaborator — starring an asset on one
 * browser must not appear on another; neither should one user's crop
 * tool selection.
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { nanoid } from 'nanoid';
import type { ImageEditorRightSidePanelId } from '@/apps/project/components/mixedEditor/types';

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
  activeTool: MixedEditorActiveTool;
  /** Per-node flag. When non-empty, ReactFlow wheel pan/pinch is disabled. */
  expandViewportLocks: Record<string, true>;
  favoriteAssets: MixedEditorFavoriteAsset[];
}

const initialState: MixedEditorState = {
  activeTool: 'select',
  expandViewportLocks: {},
  favoriteAssets: [],
};

const mixedEditorSlice = createSlice({
  name: 'mixedEditor',
  initialState,
  reducers: {
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
  setMixedEditorActiveTool,
  setMixedEditorExpandViewportLock,
  clearMixedEditorExpandLock,
  pruneMixedEditorExpandLocks,
  toggleMixedEditorFavoriteAsset,
} = mixedEditorSlice.actions;

export default mixedEditorSlice.reducer;
