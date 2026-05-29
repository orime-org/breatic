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

export { useUIStore } from '@web/stores/ui';
export { usePreferencesStore } from '@web/stores/preferences';
export type { ThemeMode } from '@web/stores/preferences';
export { useCurrentUserStore } from '@web/stores/current-user';
export type { CurrentUser, UserRole } from '@web/stores/current-user';
export { useCanvasStore } from '@web/stores/canvas';
export { useMiniToolStore } from '@web/stores/mini-tool';
export type { MiniToolStatus, MiniToolSession } from '@web/stores/mini-tool';
export { useInpaintStore } from '@web/stores/inpaint';
export type { BrushMode } from '@web/stores/inpaint';
export { useChatStore } from '@web/stores/chat';
export { useStudioStore } from '@web/stores/studio';
export type { ProjectSortKey, ProjectSortOrder } from '@web/stores/studio';
export { useProjectStore } from '@web/stores/project';
export type { ProjectRole, ActiveProjectMeta } from '@web/stores/project';
export { useToastStore } from '@web/stores/toast';
export type { ToastVariant, ToastEntry } from '@web/stores/toast';
