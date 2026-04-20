import mixedEditorReducer, {
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
} from './mixedEditor';
import type {
  MixedEditorActiveTool,
  MixedEditorFavoriteAsset,
  ToggleMixedEditorFavoritePayload,
} from './mixedEditor';

/** @deprecated Use `MixedEditorActiveTool` from `mixedEditor` module. */
export type ImageEditorActiveTool = MixedEditorActiveTool;
/** @deprecated Use `MixedEditorFavoriteAsset` from `mixedEditor` module. */
export type ImageEditorFavoriteAsset = MixedEditorFavoriteAsset;
/** @deprecated Use `ToggleMixedEditorFavoritePayload` from `mixedEditor` module. */
export type ToggleImageEditorFavoritePayload = ToggleMixedEditorFavoritePayload;

/** @deprecated Use `resetMixedEditor` from `mixedEditor` module. */
export const resetImageEditor = resetMixedEditor;
/** @deprecated Use `resetMixedEditorNodes` from `mixedEditor` module. */
export const resetImageEditorNodes = resetMixedEditorNodes;
/** @deprecated Use `setMixedEditorNodes` from `mixedEditor` module. */
export const setImageEditorNodes = setMixedEditorNodes;
/** @deprecated Use `applyMixedEditorNodeChanges` from `mixedEditor` module. */
export const applyImageEditorNodeChanges = applyMixedEditorNodeChanges;
/** @deprecated Use `addMixedEditorNode` from `mixedEditor` module. */
export const addImageEditorNode = addMixedEditorNode;
/** @deprecated Use `updateMixedEditorNode` from `mixedEditor` module. */
export const updateImageEditorNode = updateMixedEditorNode;
/** @deprecated Use `appendMixedEditorNodes` from `mixedEditor` module. */
export const appendImageEditorNodes = appendMixedEditorNodes;
/** @deprecated Use `patchMixedEditorNodeData` from `mixedEditor` module. */
export const patchImageEditorNodeData = patchMixedEditorNodeData;
/** @deprecated Use `removeMixedEditorNode` from `mixedEditor` module. */
export const removeImageEditorNode = removeMixedEditorNode;
/** @deprecated Use `resetMixedEditorEdges` from `mixedEditor` module. */
export const resetImageEditorEdges = resetMixedEditorEdges;
/** @deprecated Use `setMixedEditorEdges` from `mixedEditor` module. */
export const setImageEditorEdges = setMixedEditorEdges;
/** @deprecated Use `syncMixedEditorFromYjs` from `mixedEditor` module. */
export const syncImageEditorFromYjs = syncMixedEditorFromYjs;
/** @deprecated Use `applyMixedEditorEdgeChanges` from `mixedEditor` module. */
export const applyImageEditorEdgeChanges = applyMixedEditorEdgeChanges;
/** @deprecated Use `addMixedEditorEdge` from `mixedEditor` module. */
export const addImageEditorEdge = addMixedEditorEdge;
/** @deprecated Use `setMixedEditorActiveTool` from `mixedEditor` module. */
export const setImageEditorActiveTool = setMixedEditorActiveTool;
/** @deprecated Use `setMixedEditorExpandViewportLock` from `mixedEditor` module. */
export const setImageEditorExpandViewportLock = setMixedEditorExpandViewportLock;
/** @deprecated Use `clearMixedEditorExpandLock` from `mixedEditor` module. */
export const clearImageEditorExpandLock = clearMixedEditorExpandLock;
/** @deprecated Use `pruneMixedEditorExpandLocks` from `mixedEditor` module. */
export const pruneImageEditorExpandLocks = pruneMixedEditorExpandLocks;
/** @deprecated Use `toggleMixedEditorFavoriteAsset` from `mixedEditor` module. */
export const toggleImageEditorFavoriteAsset = toggleMixedEditorFavoriteAsset;

export default mixedEditorReducer;
