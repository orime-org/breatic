// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { projectsApi } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';
import type { NewItemValues } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { defaultCreateStudioId } from '@web/pages/studio/container/dialogs/studio-create';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

/**
 * The create-project flow shared by the rail (a global entry) and the container
 * Projects tab (spec §7 / §8.2). It creates the project in the studio the user
 * selected — the server checks the caller is that studio's `admin`/`creator`
 * and rejects otherwise (§8.2) — then refreshes that studio's projects and
 * navigates to it, so the new card appears wherever the project landed (even if
 * it differs from the studio the dialog opened in). On failure it surfaces the
 * error as a toast (an application-layer concern; the API layer stays silent).
 * @param studios the viewer's studios (used to resolve the fallback default + the target slug).
 * @returns a `mutate(values)` to call when the create dialog submits.
 */
export function useCreateProject(
  studios: readonly StudioSummary[],
): (values: NewItemValues) => void {
  const t = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (values: NewItemValues) => {
      // The dialog selector sets `studioId`; fall back to the computed default
      // (defends the case where the dialog rendered without a selector).
      const studioId = values.studioId ?? defaultCreateStudioId(studios);
      if (studioId === undefined) {
        return Promise.reject(new Error('no creatable studio'));
      }
      return projectsApi.create({
        studioId,
        name: values.name,
        slug: values.slug,
        visibility: values.visibility,
        spaceType: values.spaceType ?? 'canvas',
        description: values.description || undefined,
      });
    },
    onSuccess: (project) => {
      const target = studios.find((s) => s.id === project.studioId);
      void queryClient.invalidateQueries({
        queryKey: ['studio', target?.slug, 'projects'],
      });
      if (target !== undefined) {
        navigate(`/studio/${target.slug}`);
      }
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '';
      toast.error(t('studio.container.projects.createError'), {
        description: message || undefined,
      });
    },
  });
  return mutation.mutate;
}
