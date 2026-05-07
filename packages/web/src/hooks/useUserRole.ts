/**
 * `useUserRole(projectId, currentUserId, metaProvider)` — derive
 * the current user's role on a project from `useProjectMembers`.
 *
 * Returns `null` while the members list is loading, or when the
 * caller has no active membership row. UI gating (e.g. hide chat
 * for `view`) should treat `null` as "not yet authoritative" —
 * render a loading shell, not the unrestricted UI.
 *
 * The caller passes `currentUserId` rather than reading from a
 * client store because the breatic web's `userInfo` redux slice
 * does not (currently) carry `id`. Resolving the id is the
 * caller's concern (typically: `getMe()` once at app boot).
 */

import { useMemo } from 'react';
import type { ProjectRole } from '@breatic/shared';
import { useProjectMembers } from './useProjectMembers';
import type { ProjectMetaManager } from '@/data/yjs/project-meta';

export interface UseUserRoleResult {
  role: ProjectRole | null;
  loading: boolean;
}

export function useUserRole(
  projectId: string | null,
  currentUserId: string | null,
  metaProvider: ProjectMetaManager['provider'] | null,
): UseUserRoleResult {
  const { members, loading } = useProjectMembers(projectId, metaProvider);

  return useMemo<UseUserRoleResult>(() => {
    if (loading) return { role: null, loading: true };
    if (!currentUserId) return { role: null, loading: false };
    const row = members.find((m) => m.userId === currentUserId);
    return { role: (row?.role as ProjectRole | undefined) ?? null, loading: false };
  }, [members, loading, currentUserId]);
}
