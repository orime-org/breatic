/**
 * `app/store` — Zustand app-wide stores. Replaces the previous
 * `src/store/` Redux slices (migration: 2026-05-12). Each store owns
 * one cross-cutting concern; nothing here is route-specific or
 * canvas-scoped — see `domain/` and `spaces/` for those layers.
 */
export { useUserCenter } from './userCenterStore';
export type { UserInfoType, AuthenticatedInfoType } from './userCenterStore';
export { useProjectInfo } from './projectInfoStore';
export { useLoadingStore, loadingActions } from './loadingStore';
