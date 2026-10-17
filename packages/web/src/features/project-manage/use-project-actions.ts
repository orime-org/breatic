// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { invalidateProjectListings, projectsApi } from '@web/data/api';
import { useTranslation } from '@web/i18n/use-translation';
import { toastFailure } from '@web/features/project-manage/toast-failure';
import { reportConversion } from '@web/data/analytics';
import { toast } from '@web/lib/toast';

/** A project's server-side management actions, each settling with a toast. */
export interface ProjectActions {
  duplicate: () => void;
  /**
   * Archive; `onSuccess` runs once the archive is in and the lists showing the
   * project have refreshed (the confirmation closes there).
   */
  archive: (options?: { onSuccess?: () => void }) => void;
  restore: () => void;
  /** True while any of the three is in flight. */
  pending: boolean;
  /** True while the archive is in flight. */
  archiving: boolean;
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
      if (copy.isFirst === true) reportConversion('first_project', `first-project:${copy.createdByUserId}`);
      void invalidateProjectListings(queryClient, projectId);
      toast.success(t('studio.container.card.duplicated', { name: copy.name }));
    },
    onError: toastFailure(t('studio.container.card.duplicateFailed')),
  });
  const archive = useMutation({
    mutationFn: () => projectsApi.archive(projectId),
    // Awaited (inner#1374). The confirmation lives inside the card and leaves
    // with it once the live list refetch drops the card. The archived lists are
    // waited on too, so the "Archived" toast waits until the Archived tab's
    // count is refreshed.
    onSuccess: async () => {
      await invalidateProjectListings(queryClient, projectId, { archivedChanges: true });
      toast.success(t('studio.container.card.archived'));
    },
    onError: toastFailure(t('studio.container.card.archiveFailed')),
  });
  const restore = useMutation({
    mutationFn: () => projectsApi.restore(projectId),
    // Awaited so `isPending` lasts until the project refetch lands: the
    // banner's restore button goes away only then, and a press in between
    // would send a restore the server refuses (inner#1374).
    onSuccess: async () => {
      await invalidateProjectListings(queryClient, projectId, { archivedChanges: true });
      toast.success(t('studio.container.card.restored'));
    },
    onError: toastFailure(t('studio.container.card.restoreFailed')),
  });

  const { mutate: mutateArchive } = archive;
  const runArchive = React.useCallback(
    (options?: { onSuccess?: () => void }): void => mutateArchive(undefined, options),
    [mutateArchive],
  );

  return {
    duplicate: duplicate.mutate,
    archive: runArchive,
    restore: restore.mutate,
    pending: duplicate.isPending || archive.isPending || restore.isPending,
    archiving: archive.isPending,
  };
}
