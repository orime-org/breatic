// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { CREDITS_CHANGED_SIGNAL } from '@breatic/shared';

import { useProjectSignal } from '@web/pages/project/use-project-signal';

/**
 * Read the project's credits again whenever they move (inner#1611, #1580): collab sends `credits:changed` to every live
 * Project of the Studio when a hold, a charge (one recorded only as a debt included) or a refund commits there, and
 * when a hold comes due. That one message covers this user's own runs and everyone else's.
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

  useProjectSignal(provider, projectId, CREDITS_CHANGED_SIGNAL, refresh);
}
