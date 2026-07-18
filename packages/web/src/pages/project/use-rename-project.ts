// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toast } from '@web/lib/toast';

import { projectsApi } from '@web/data/api/projects';
import type { ProjectDetail } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';

/**
 * Whether a React Query key is a studio container projects-list key, i.e.
 * `['studio', <slug>, 'projects']` (spec §6 / slice 2). Used to invalidate
 * every studio's projects list after a project rename without knowing the
 * studio slug (ProjectPage only has the project id).
 * @param key the React Query key to test.
 * @returns whether the key is a studio projects-list key.
 */
export function isStudioProjectsListKey(key: readonly unknown[]): boolean {
  return key[0] === 'studio' && key[2] === 'projects';
}

/** Optimistic-update rollback context: the project detail snapshot before the rename. */
interface RenameContext {
  previous: unknown;
}

/**
 * Rename mutation for a project (the in-project title editor). It optimistically
 * updates the in-project header (`['project', id]`), rolls back + toasts on
 * error, and on success refreshes BOTH the in-project header AND the studio
 * container's projects list so the new name shows after navigating back to the
 * studio. The studio list is keyed `['studio', <slug>, 'projects']`; since
 * ProjectPage has no slug, it is matched by predicate (#1068 — the previous
 * `['projects', 'list']` key was dead after the studio redesign re-keyed the
 * list, so the rename never refreshed it).
 * @param projectId the project being renamed.
 * @returns the rename mutation (call `.mutate(newName)`).
 */
export function useRenameProject(
  projectId: string,
): UseMutationResult<ProjectDetail, Error, string, RenameContext> {
  const queryClient = useQueryClient();
  const t = useTranslation();
  return useMutation({
    mutationFn: (name: string) => projectsApi.rename(projectId, name),
    onMutate: async (next: string) => {
      await queryClient.cancelQueries({ queryKey: ['project', projectId] });
      const previous = queryClient.getQueryData(['project', projectId]);
      queryClient.setQueryData(
        ['project', projectId],
        (old: { name: string } | undefined) =>
          old ? { ...old, name: next } : old,
      );
      return { previous };
    },
    onError: (err, _next, ctx) => {
      if (ctx && 'previous' in ctx) {
        queryClient.setQueryData(['project', projectId], ctx.previous);
      }
      const message = err instanceof Error ? err.message : '';
      toast.error(t('project.header.renameFailed'), { description: message });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      // Refresh every studio's projects list (the rename changes a name shown
      // there). Matched by predicate because ProjectPage has no studio slug.
      void queryClient.invalidateQueries({
        predicate: (query) => isStudioProjectsListKey(query.queryKey),
      });
    },
  });
}
