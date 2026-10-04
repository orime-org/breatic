// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { invalidateProjectListings, projectsApi } from '@web/data/api';
import { useTranslation } from '@web/i18n/use-translation';
import { toastFailure } from '@web/features/project-manage/toast-failure';
import { toast } from '@web/lib/toast';

/** A project's server-side management actions, each settling with a toast. */
export interface ProjectActions {
  duplicate: () => void;
  archive: () => void;
  restore: () => void;
  /** True while any of the three is in flight. */
  pending: boolean;
}

/**
 * Duplicate, archive and restore for one project — from its studio card, and
 * restore also from the banner inside the archived project.
 *
 * Every one of them changes which list a project sits in, so each success
 * refetches every studio's project lists (live and archived; the banner does
 * not know the studio's slug), the Recent landing, and the project's own
 * detail for anyone who has it open. A failure toasts the server's sentence,
 * which names the reason (a full studio, an already-archived project).
 * @param projectId - The project.
 * @returns The three actions and whether one is running.
 */
export function useProjectActions(projectId: string): ProjectActions {
  const t = useTranslation();
  const queryClient = useQueryClient();

  const duplicate = useMutation({
    mutationFn: () => projectsApi.duplicate(projectId),
    onSuccess: (copy) => {
      invalidateProjectListings(queryClient, projectId);
      toast.success(t('studio.container.card.duplicated', { name: copy.name }));
    },
    onError: toastFailure(t('studio.container.card.duplicateFailed')),
  });
  const archive = useMutation({
    mutationFn: () => projectsApi.archive(projectId),
    onSuccess: () => {
      invalidateProjectListings(queryClient, projectId);
      toast.success(t('studio.container.card.archived'));
    },
    onError: toastFailure(t('studio.container.card.archiveFailed')),
  });
  const restore = useMutation({
    mutationFn: () => projectsApi.restore(projectId),
    onSuccess: () => {
      invalidateProjectListings(queryClient, projectId);
      toast.success(t('studio.container.card.restored'));
    },
    onError: toastFailure(t('studio.container.card.restoreFailed')),
  });

  return {
    duplicate: duplicate.mutate,
    archive: archive.mutate,
    restore: restore.mutate,
    pending: duplicate.isPending || archive.isPending || restore.isPending,
  };
}
