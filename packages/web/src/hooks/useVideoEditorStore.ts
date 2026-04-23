import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { MediaItem, TimelineClip } from '@/apps/videoEditor/types';

const HISTORY_LIMIT = 80;

type HistorySnapshot = {
  clips: TimelineClip[];
  mediaItems: MediaItem[];
};

export type VideoEditorStoreState = {
  clips: TimelineClip[];
  mediaItems: MediaItem[];
  selectedClipId: string[];
  past: HistorySnapshot[];
  future: HistorySnapshot[];
};

type VideoEditorStoreActions = {
  pushHistory: () => void;
  setClips: (clips: TimelineClip[]) => void;
  setMediaItems: (mediaItems: MediaItem[]) => void;
  setSelectedClipId: (ids: string[]) => void;
  addMediaItem: (item: MediaItem) => void;
  addClip: (clip: TimelineClip) => void;
  updateClip: (clipId: string, patch: Partial<TimelineClip>) => void;
  batchUpdateClips: (clips: TimelineClip[]) => void;
  undo: () => void;
  redo: () => void;
};

export type VideoEditorStore = VideoEditorStoreState & VideoEditorStoreActions;

function createVideoEditorStore(): StoreApi<VideoEditorStore> {
  return createStore<VideoEditorStore>((set, get) => ({
    clips: [],
    mediaItems: [],
    selectedClipId: [],
    past: [],
    future: [],

    pushHistory: () => {
      const { clips, mediaItems, past } = get();
      const nextPast = [...past, { clips, mediaItems: [...mediaItems] }].slice(-HISTORY_LIMIT);
      set({ past: nextPast, future: [] });
    },

    setClips: (clips) => {
      get().pushHistory();
      set({ clips });
    },

    setMediaItems: (mediaItems) => {
      get().pushHistory();
      set({ mediaItems });
    },

    setSelectedClipId: (selectedClipId) => set({ selectedClipId }),

    addMediaItem: (item) => {
      get().pushHistory();
      set((s) => ({ mediaItems: [...s.mediaItems, item] }));
    },

    addClip: (clip) => {
      get().pushHistory();
      set((s) => {
        // Always insert new content at the top track.
        // Existing clips are shifted down by one track to preserve relative order.
        const shiftedClips = s.clips.map((existingClip) => ({
          ...existingClip,
          trackIndex: existingClip.trackIndex + 1,
        }));

        return {
          clips: [{ ...clip, trackIndex: 0 }, ...shiftedClips],
          selectedClipId: [clip.id],
        };
      });
    },

    updateClip: (clipId, patch) => {
      get().pushHistory();
      set((s) => ({
        clips: s.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
      }));
    },

    batchUpdateClips: (clips) => {
      get().pushHistory();
      set({ clips });
    },

    undo: () => {
      const { past, clips, mediaItems, future } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        clips: prev.clips,
        mediaItems: prev.mediaItems,
        past: past.slice(0, -1),
        future: [{ clips, mediaItems: [...mediaItems] }, ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { future, clips, mediaItems, past } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        clips: next.clips,
        mediaItems: next.mediaItems,
        future: future.slice(1),
        past: [...past, { clips, mediaItems: [...mediaItems] }].slice(-HISTORY_LIMIT),
      });
    },
  }));
}

const storeCache = new Map<string, StoreApi<VideoEditorStore>>();

function getVideoEditorStore(nodeId?: string) {
  const key = nodeId && nodeId.length > 0 ? nodeId : '__local__';
  let s = storeCache.get(key);
  if (!s) {
    s = createVideoEditorStore();
    storeCache.set(key, s);
  }
  return s;
}

export function useVideoEditorStore(nodeId?: string) {
  const store = getVideoEditorStore(nodeId);
  return useStore(
    store,
    useShallow((s) => ({
      clips: s.clips,
      mediaItems: s.mediaItems,
      selectedClipId: s.selectedClipId,
      setClips: s.setClips,
      setMediaItems: s.setMediaItems,
      setSelectedClipId: s.setSelectedClipId,
      addMediaItem: s.addMediaItem,
      addClip: s.addClip,
      updateClip: s.updateClip,
      batchUpdateClips: s.batchUpdateClips,
      undo: s.undo,
      redo: s.redo,
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0,
    }))
  );
}

export function useVideoEditorStoreApi(nodeId?: string) {
  return getVideoEditorStore(nodeId);
}
