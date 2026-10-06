// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { invalidateProjectListings, projectsApi } from '@web/data/api';
import { useTranslation } from '@web/i18n/use-translation';
import { toastFailure } from '@web/features/project-manage/toast-failure';
import { toast } from '@web/lib/toast';

/** Leaving one project, and whether the request is in flight. */
export interface LeaveProject {
  leave: () => void;
  pending: boolean;
}

/**
 * Leave a project — from its studio card, or from inside the project.
 *
 * The follow-up lives on the mutation, not on the call: inside the project
 * the server's collab kick swaps the page out before the response arrives,
 * and only the mutation's own callbacks still run once the component that
 * started it has unmounted. On success the project's cached detail is
 * dropped (refetching it now only answers that the caller is not a member),
 * every list that showed it is refreshed, and `onLeft` takes over.
 * @param projectId - The project.
 * @param name - Its name, quoted in the toast.
 * @param onLeft - What to do once the caller has left; the project page leaves the page.
 * @returns The leave action and whether it is running.
 */
export function useLeaveProject(projectId: string, name: string, onLeft?: () => void): LeaveProject {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => projectsApi.leave(projectId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['project', projectId] });
      invalidateProjectListings(queryClient, projectId);
      toast.success(t('project.leave.done', { name }));
      onLeft?.();
    },
    onError: toastFailure(t('project.leave.failed')),
  });
  const { mutate } = mutation;
  // Wrapped so a click event never reaches `mutate` as its variables.
  const leave = React.useCallback((): void => mutate(), [mutate]);
  return { leave, pending: mutation.isPending };
}
