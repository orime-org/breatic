import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { MediaItem, TimelineClip } from '@/spaces/timeline/types';

const HISTORY_LIMIT = 80;

type HistorySnapshot = {
  clips: TimelineClip[];
  mediaItems: MediaItem[];
};

export interface VideoEditorState {
  clips: TimelineClip[];
  mediaItems: MediaItem[];
  selectedClipId: string[];
  past: HistorySnapshot[];
  future: HistorySnapshot[];
}

const initialState: VideoEditorState = {
  clips: [],
  mediaItems: [],
  selectedClipId: [],
  past: [],
  future: [],
};

const cloneSnapshot = (state: VideoEditorState): HistorySnapshot => ({
  clips: [...state.clips],
  mediaItems: [...state.mediaItems],
});

const pushHistory = (state: VideoEditorState) => {
  state.past = [...state.past, cloneSnapshot(state)].slice(-HISTORY_LIMIT);
  state.future = [];
};

const videoEditorSlice = createSlice({
  name: 'videoEditor',
  initialState,
  reducers: {
    setVideoEditorClips: (state, action: PayloadAction<TimelineClip[]>) => {
      pushHistory(state);
      state.clips = action.payload;
    },
    setVideoEditorMediaItems: (state, action: PayloadAction<MediaItem[]>) => {
      pushHistory(state);
      state.mediaItems = action.payload;
    },
    setVideoEditorSelectedClipId: (state, action: PayloadAction<string[]>) => {
      state.selectedClipId = action.payload;
    },
    addVideoEditorMediaItem: (state, action: PayloadAction<MediaItem>) => {
      pushHistory(state);
      state.mediaItems.push(action.payload);
    },
    addVideoEditorClip: (state, action: PayloadAction<TimelineClip>) => {
      pushHistory(state);
      state.clips = [
        { ...action.payload, trackIndex: 0 },
        ...state.clips.map((clip) => ({ ...clip, trackIndex: clip.trackIndex + 1 })),
      ];
      state.selectedClipId = [action.payload.id];
    },
    updateVideoEditorClip: (state, action: PayloadAction<{ clipId: string; patch: Partial<TimelineClip> }>) => {
      pushHistory(state);
      state.clips = state.clips.map((clip) =>
        clip.id === action.payload.clipId ? { ...clip, ...action.payload.patch } : clip,
      );
    },
    batchUpdateVideoEditorClips: (state, action: PayloadAction<TimelineClip[]>) => {
      pushHistory(state);
      state.clips = action.payload;
    },
    undoVideoEditor: (state) => {
      if (!state.past.length) return;
      const prev = state.past[state.past.length - 1];
      state.future = [cloneSnapshot(state), ...state.future].slice(0, HISTORY_LIMIT);
      state.past = state.past.slice(0, -1);
      state.clips = prev.clips;
      state.mediaItems = prev.mediaItems;
    },
    redoVideoEditor: (state) => {
      if (!state.future.length) return;
      const next = state.future[0];
      state.past = [...state.past, cloneSnapshot(state)].slice(-HISTORY_LIMIT);
      state.future = state.future.slice(1);
      state.clips = next.clips;
      state.mediaItems = next.mediaItems;
    },
  },
});

export const {
  setVideoEditorClips,
  setVideoEditorMediaItems,
  setVideoEditorSelectedClipId,
  addVideoEditorMediaItem,
  addVideoEditorClip,
  updateVideoEditorClip,
  batchUpdateVideoEditorClips,
  undoVideoEditor,
  redoVideoEditor,
} = videoEditorSlice.actions;

export default videoEditorSlice.reducer;
