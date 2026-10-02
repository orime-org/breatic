// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { projectsApi } from '@web/data/api/projects';
import { useTranslation } from '@web/i18n/use-translation';
import {
  pictureErrorMessage,
  uploadPicture,
} from '@web/pages/studio/shared/upload-picture';

/** What the cover crop dialog needs from an upload in progress. */
export interface ProjectCoverUpload {
  /** Upload the cropped cover and point the project at it. */
  upload: (cover: Blob) => void;
  uploading: boolean;
  /** Why the last attempt failed, shown inside the crop dialog. */
  error: string | null;
  /** True once the last attempt succeeded, which closes the dialog. */
  done: boolean;
  /** Forget the last attempt, when the dialog is dismissed. */
  reset: () => void;
}

/**
 * Replace a project's cover: upload the crop as an asset, then point the
 * project at it. The picture it replaces stays in the studio's assets.
 *
 * Both lists that show the cover are refreshed — the studio's Projects tab and
 * the Recent page.
 * @param projectId - The project whose cover this is.
 * @param studioSlug - The studio whose Projects tab lists it.
 * @returns The upload action and its state.
 */
export function useProjectCover(projectId: string, studioSlug: string): ProjectCoverUpload {
  const t = useTranslation();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (cover: Blob) => {
      const assetId = await uploadPicture(cover, {
        projectId,
        purpose: 'project_cover',
      });
      return projectsApi.setCover(projectId, assetId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['studio', studioSlug, 'projects'] });
      void queryClient.invalidateQueries({ queryKey: ['studios', 'recent'] });
    },
  });

  const { mutate, reset, isPending, isSuccess, error } = mutation;

  const message = React.useMemo((): string | null => {
    if (error === null) return null;
    return pictureErrorMessage(error, t, {
      storage: 'studio.container.cover.error.storage',
      upload: 'studio.container.cover.error.upload',
    });
  }, [error, t]);

  const upload = React.useCallback((cover: Blob): void => mutate(cover), [mutate]);

  return React.useMemo(
    () => ({ upload, uploading: isPending, error: message, done: isSuccess, reset }),
    [upload, isPending, message, isSuccess, reset],
  );
}
