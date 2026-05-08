import { useCallback } from 'react';
import { shallowEqual, useDispatch, useSelector } from 'react-redux';
import type { RootState } from '@/store';
import type { MediaItem, TimelineClip } from '@/spaces/timeline/types';
import {
  addVideoEditorClip,
  addVideoEditorMediaItem,
  batchUpdateVideoEditorClips,
  redoVideoEditor,
  setVideoEditorClips,
  setVideoEditorMediaItems,
  setVideoEditorSelectedClipId,
  undoVideoEditor,
  updateVideoEditorClip,
} from '@/store/modules/videoEditor';

export function useVideoEditorStore() {
  const dispatch = useDispatch();
  const videoEditor = useSelector((state: RootState) => state.videoEditor, shallowEqual);

  const setClips = useCallback(
    (clips: TimelineClip[]) => dispatch(setVideoEditorClips(clips)),
    [dispatch],
  );
  const setMediaItems = useCallback(
    (mediaItems: MediaItem[]) => dispatch(setVideoEditorMediaItems(mediaItems)),
    [dispatch],
  );
  const setSelectedClipId = useCallback(
    (ids: string[]) => dispatch(setVideoEditorSelectedClipId(ids)),
    [dispatch],
  );
  const addMediaItem = useCallback(
    (item: MediaItem) => dispatch(addVideoEditorMediaItem(item)),
    [dispatch],
  );
  const addClip = useCallback(
    (clip: TimelineClip) => dispatch(addVideoEditorClip(clip)),
    [dispatch],
  );
  const updateClip = useCallback(
    (clipId: string, patch: Partial<TimelineClip>) => dispatch(updateVideoEditorClip({ clipId, patch })),
    [dispatch],
  );
  const batchUpdateClips = useCallback(
    (clips: TimelineClip[]) => dispatch(batchUpdateVideoEditorClips(clips)),
    [dispatch],
  );
  const undo = useCallback(() => dispatch(undoVideoEditor()), [dispatch]);
  const redo = useCallback(() => dispatch(redoVideoEditor()), [dispatch]);

  return {
    clips: videoEditor.clips,
    mediaItems: videoEditor.mediaItems,
    selectedClipId: videoEditor.selectedClipId,
    setClips,
    setMediaItems,
    setSelectedClipId,
    addMediaItem,
    addClip,
    updateClip,
    batchUpdateClips,
    undo,
    redo,
    canUndo: videoEditor.past.length > 0,
    canRedo: videoEditor.future.length > 0,
  };
}
