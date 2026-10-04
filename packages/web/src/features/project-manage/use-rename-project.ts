// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toastFailure } from '@web/features/project-manage/toast-failure';

import { invalidateProjectListings, projectsApi } from '@web/data/api/projects';
import type { ProjectDetail } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';

/** Optimistic-update rollback context: the project detail snapshot before the rename. */
interface RenameContext {
  previous: unknown;
}

/**
 * Rename a project, from the project page's title or a studio card's menu.
 * The project page header (`['project', id]`) changes at once and is put back,
 * with a toast, if the rename fails; on success every listing that shows the
 * name is refreshed through {@link invalidateProjectListings}.
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
      toastFailure(t('project.header.renameFailed'))(err);
    },
    onSuccess: () => invalidateProjectListings(queryClient, projectId),
  });
}
