/**
 * Zustand store barrel — single import surface for all stores.
 *
 * Each store is a single file in this directory. Stores do NOT import each
 * other (rule from frontend-architecture.md); cross-store composition is
 * done in hooks via `useFooStore` + `useBarStore` calls, or via Effect
 * synchronization at the component level.
 *
 * Yjs source-of-truth data does NOT live in any store here. Node data /
 * spaces list flow through `data/yjs/` bindings.
 */

export { useUIStore } from './ui';
export { usePreferencesStore } from './preferences';
export type { ThemeMode } from './preferences';
export { useCurrentUserStore } from './current-user';
export type { CurrentUser, UserRole } from './current-user';
export { useCanvasStore } from './canvas';
export { useMiniToolStore } from './mini-tool';
export type { MiniToolStatus, MiniToolSession } from './mini-tool';
export { useInpaintStore } from './inpaint';
export type { BrushMode } from './inpaint';
export { useChatStore } from './chat';
export { useStudioStore } from './studio';
export type { ProjectSortKey, ProjectSortOrder } from './studio';
export { useProjectStore } from './project';
export type { ProjectRole, ActiveProjectMeta } from './project';
export { useToastStore } from './toast';
export type { ToastVariant, ToastEntry } from './toast';
