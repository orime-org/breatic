/**
 * Mixed editor UI-only state hook.
 *
 * Holds everything the user controls that is NOT synced to Yjs:
 *   - `activeTool` — which toolbar mode is active (crop / brush / ...)
 *   - `expandViewportLocked` — whether any node currently has "expand"
 *     interaction locked to its viewport
 *   - `favoriteAssets` — user-starred images for the side panel
 *
 * By contrast, node data (position, content, state, ...) is the Yjs
 * authority — read via `useMixedEditorData`, write via
 * `useMixedEditorActions`.
 *
 * This split mirrors the main canvas (`useCanvasData` / `useCanvasActions`
 * / `useCanvasUI`): Yjs for collaborative truth, Redux for local UI.
 */

import { useCallback } from 'react';
import { useDispatch, useSelector, shallowEqual } from 'react-redux';
import type { RootState } from '@/store';
import {
  setMixedEditorActiveTool,
  setMixedEditorExpandViewportLock,
  toggleMixedEditorFavoriteAsset,
  type MixedEditorActiveTool,
  type MixedEditorFavoriteAsset,
  type ToggleMixedEditorFavoritePayload,
} from '@/store/modules/mixedEditor';
import type { EditorTool } from '@/apps/project/components/mixedEditor/types';

const selectActiveTool = (s: RootState) => s.mixedEditor.activeTool;
const selectExpandViewportLocked = (s: RootState) =>
  Object.keys(s.mixedEditor.expandViewportLocks ?? {}).length > 0;
const selectFavoriteAssets = (s: RootState) => s.mixedEditor.favoriteAssets ?? [];

export interface UseMixedEditorUIResult {
  activeTool: EditorTool;
  setActiveTool: (tool: EditorTool) => void;

  expandViewportLocked: boolean;
  setExpandViewportLock: (nodeId: string, locked: boolean) => void;

  favoriteAssets: MixedEditorFavoriteAsset[];
  toggleFavoriteAsset: (payload: ToggleMixedEditorFavoritePayload) => void;
}

export function useMixedEditorUI(): UseMixedEditorUIResult {
  const dispatch = useDispatch();
  const activeTool = useSelector(selectActiveTool) as EditorTool;
  const expandViewportLocked = useSelector(selectExpandViewportLocked);
  const favoriteAssets = useSelector(selectFavoriteAssets, shallowEqual);

  const setActiveTool = useCallback(
    (tool: EditorTool) => {
      dispatch(setMixedEditorActiveTool(tool as MixedEditorActiveTool));
    },
    [dispatch],
  );

  const setExpandViewportLock = useCallback(
    (nodeId: string, locked: boolean) => {
      dispatch(setMixedEditorExpandViewportLock({ nodeId, locked }));
    },
    [dispatch],
  );

  const toggleFavoriteAsset = useCallback(
    (payload: ToggleMixedEditorFavoritePayload) => {
      dispatch(toggleMixedEditorFavoriteAsset(payload));
    },
    [dispatch],
  );

  return {
    activeTool,
    setActiveTool,
    expandViewportLocked,
    setExpandViewportLock,
    favoriteAssets,
    toggleFavoriteAsset,
  };
}
