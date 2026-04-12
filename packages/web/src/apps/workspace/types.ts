import type { ProjectEntity } from '@breatic/shared';

/**
 * Canonical project type for the workspace surface.
 *
 * Re-exports the shared backend entity so the workspace components
 * never have to know about the mock/localStorage shape that used to
 * live here. One source of truth lives in `@breatic/shared`.
 */
export type WorkspaceProject = ProjectEntity;
