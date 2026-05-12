/**
 * `projectInfoStore` — Zustand replacement for the old Redux
 * `projectInfo` slice. Single field today: `autosaveTime`, the unix-ms
 * timestamp of the most recent Yjs autosave, displayed in the top bar.
 *
 * Lives on its own store (rather than folded into `userCenterStore`)
 * because the autosave write fires per Yjs change and `userCenter`
 * stays cold; a shared store would force every theme/language read to
 * re-subscribe to autosave updates.
 */
import { create } from 'zustand';

interface ProjectInfoState {
  autosaveTime: number;
  setAutosaveTime: (autosaveTime: number) => void;
}

export const useProjectInfo = create<ProjectInfoState>((set) => ({
  autosaveTime: 0,
  setAutosaveTime: (autosaveTime) => set({ autosaveTime }),
}));
