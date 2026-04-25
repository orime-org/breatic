/** Autosave timestamp for project collaboration state. */
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface ProjectInfoState {
  autosaveTime: number;
}

const initialState: ProjectInfoState = {
  autosaveTime: 0,
};

const projectInfoSlice = createSlice({
  name: 'projectInfo',
  initialState,
  reducers: {
    setAutosaveTime: (state, action: PayloadAction<number>) => {
      state.autosaveTime = action.payload;
    },
  },
});

export const { setAutosaveTime: setAutosaveTimeAction } = projectInfoSlice.actions;

export default projectInfoSlice.reducer;
