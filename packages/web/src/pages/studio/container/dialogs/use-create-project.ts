// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@web/lib/toast';

import { projectsApi, type CreatedProject } from '@web/data/api/projects';
import { reportConversion } from '@web/data/analytics';
import { useTranslation } from '@web/i18n/use-translation';
import type { NewItemValues } from '@web/pages/studio/container/dialogs/NewItemDialog';
import { defaultCreateStudioId } from '@web/pages/studio/container/dialogs/studio-create';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';

/**
 * The run-once intent of creating a project: one per page at a time, whichever entry
 * opened the dialog and whichever studio it picked (inner#1490).
 */
export const PROJECT_CREATE_INTENT = 'project:create';

/** The body `POST /projects` takes. */
type ProjectCreateBody = Parameters<typeof projectsApi.create>[0];

/**
 * Whether a project create is out; the create dialog's button reads it.
 * @returns True while it waits.
 */
export function useCreatingProject(): boolean {
  return useRunning(PROJECT_CREATE_INTENT) !== undefined;
}

/**
 * The create-project flow shared by the rail (a global entry) and the container
 * Projects tab (spec §7 / §8.2). It creates the project in the studio the user
 * selected — the server checks the caller is that studio's `admin`/`maintainer`
 * and rejects otherwise (§8.2) — then refreshes that studio's projects and
 * navigates straight INTO the new project (decision B): the creator lands in
 * the canvas, and the project page records the open so the project also surfaces
 * at the top of the cross-studio Recent landing. On failure it surfaces the
 * error as a toast (an application-layer concern; the API layer stays silent).
 * The returned function answers with a promise so the dialog can hold itself
 * open and say it is working until the create settles (#255); a rejection is
 * the dialog's cue to stay up with what was typed still in it, while the toast
 * below says what went wrong.
 *
 * The press is held in the run-once registry (inner#1490): a dialog opened
 * again while it is out shows Create busy, and an unanswered request is
 * re-sent with the same key rather than making a second project.
 * @param studios the viewer's studios (used to resolve the fallback default + the target slug).
 * @returns a `create(values)` to call when the create dialog submits.
 */
export function useCreateProject(
  studios: readonly StudioSummary[],
): (values: NewItemValues) => Promise<unknown> {
  const t = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return React.useCallback(
    async (values: NewItemValues): Promise<unknown> => {
      // The dialog selector sets `studioId`; fall back to the computed default
      // (defends the case where the dialog rendered without a selector).
      const studioId = values.studioId ?? defaultCreateStudioId(studios);
      const outcome = await runOnce(PROJECT_CREATE_INTENT, {
        scope: 'project',
        prepare: (): ProjectCreateBody => {
          if (studioId === undefined) throw new Error('no creatable studio');
          return {
            studioId,
            name: values.name,
            slug: values.slug,
            spaceType: values.spaceType ?? 'canvas',
            description: values.description || undefined,
          };
        },
        send: (key, body: ProjectCreateBody) => projectsApi.create(body, key),
        onDone: (project: CreatedProject) => {
          if (project.isFirst === true) reportConversion('first_project', `first-project:${project.createdByUserId}`);
          const target = studios.find((s) => s.id === project.studioId);
          void queryClient.invalidateQueries({
            queryKey: ['studio', target?.slug, 'projects'],
          });
          // Navigate straight INTO the new project (decision B): the creator
          // lands in the canvas, and the project page records the open so the
          // project also surfaces at the top of the cross-studio Recent landing
          // (it is invisible there until first opened). The URL slug is
          // decorative — the page keys on the uuid — so the user-typed slug
          // (stored as-is) is fine.
          navigate(`/project/${values.slug}-${project.id}`);
          return undefined;
        },
        onFailure: (err) => {
          const message = err instanceof Error ? err.message : '';
          toast.error(t('studio.container.projects.createError'), {
            description: message || undefined,
          });
        },
      });
      if (outcome.kind === 'failed') throw outcome.error;
      return outcome.kind === 'done' ? outcome.result : null;
    },
    [studios, t, navigate, queryClient],
  );
}
