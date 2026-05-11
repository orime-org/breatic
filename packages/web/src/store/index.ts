import { configureStore, combineReducers } from '@reduxjs/toolkit';
import userCenterReducer from './modules/userCenter';
import projectInfoReducer from './modules/projectInfo';
import loadingReducer from './modules/loading';
import videoEditorReducer from './modules/videoEditor';

const baseReducer = combineReducers({
  userCenter: userCenterReducer,
  projectInfo: projectInfoReducer,
  loading: loadingReducer,
  videoEditor: videoEditorReducer,
});

export type RootState = ReturnType<typeof baseReducer>;

const store = configureStore({
  reducer: baseReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
    }),
});

export type AppDispatch = typeof store.dispatch;

export default store;
