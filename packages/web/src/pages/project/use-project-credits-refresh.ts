// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { onCreditsChanged } from '@web/data/api/credits';
import { ACTIVITY_NEW_SIGNAL, CREDITS_CHANGED_SIGNAL } from '@breatic/shared';

import { useProjectSignal } from '@web/pages/project/use-project-signal';

/**
 * Read the project's credits again whenever they may have moved (inner#1611):
 * when this reader's own run request returns (its hold), when anyone's
 * generation in the project ends, and when a charge made in the project commits.
 * Focus refetching is off app-wide, so nothing else reads the figure again;
 * a hold another member's run takes shows on the next of these, or on the
 * next visit.
 * @param projectId - The project being viewed.
 * @param provider - The live meta-doc provider, or null while there is none.
 */
export function useProjectCreditsRefresh(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
): void {
  const queryClient = useQueryClient();
  const refresh = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['project', projectId, 'credits'] });
  }, [queryClient, projectId]);

  useEffect(
    () =>
      onCreditsChanged((changed) => {
        if (changed === projectId) refresh();
      }),
    [projectId, refresh],
  );

  useProjectSignal(provider, projectId, ACTIVITY_NEW_SIGNAL, refresh);
  useProjectSignal(provider, projectId, CREDITS_CHANGED_SIGNAL, refresh);
}
