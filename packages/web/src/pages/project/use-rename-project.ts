// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toast } from '@web/lib/toast';

import { invalidateProjectListings, projectsApi } from '@web/data/api/projects';
import type { ProjectDetail } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';

/** Optimistic-update rollback context: the project detail snapshot before the rename. */
interface RenameContext {
  previous: unknown;
}

/**
 * Rename mutation for a project (the in-project title editor). It optimistically
 * updates the in-project header (`['project', id]`), rolls back + toasts on
 * error, and on success refreshes the in-project header, the studio
 * container's projects lists and the Recent landing, so the new name shows
 * wherever the project is listed. It also backs the studio card's rename. The studio list is keyed `['studio', <slug>, 'projects']`; since
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
    onSuccess: () => invalidateProjectListings(queryClient, projectId),
  });
}
