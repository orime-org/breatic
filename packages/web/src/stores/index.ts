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

export { useUIStore } from '@/stores/ui';
export { usePreferencesStore } from '@/stores/preferences';
export type { ThemeMode } from '@/stores/preferences';
export { useCurrentUserStore } from '@/stores/current-user';
export type { CurrentUser, UserRole } from '@/stores/current-user';
export { useCanvasStore } from '@/stores/canvas';
export { useMiniToolStore } from '@/stores/mini-tool';
export type { MiniToolStatus, MiniToolSession } from '@/stores/mini-tool';
export { useInpaintStore } from '@/stores/inpaint';
export type { BrushMode } from '@/stores/inpaint';
export { useChatStore } from '@/stores/chat';
export { useStudioStore } from '@/stores/studio';
export type { ProjectSortKey, ProjectSortOrder } from '@/stores/studio';
export { useProjectStore } from '@/stores/project';
export type { ProjectRole, ActiveProjectMeta } from '@/stores/project';
export { useToastStore } from '@/stores/toast';
export type { ToastVariant, ToastEntry } from '@/stores/toast';
