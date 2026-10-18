// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { onCreditsChanged } from '@web/data/api/credits';
import { useActivitySignal } from '@web/pages/project/use-activity-signal';

/**
 * Read the project's credits again whenever they may have moved (inner#1611):
 * when this reader's own spend in the project returns, and when anyone's
 * generation in it ends. Focus refetching is off app-wide, so nothing else
 * reads the figure again; work another member starts has no signal and shows
 * on the next of these, or on the next visit.
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

  useActivitySignal(provider, projectId, refresh);
}
