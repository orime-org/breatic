// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { isReauthCloseReason } from '@breatic/shared';

/**
 * Refetch the project whenever collab closes its meta document to re-check it.
 *
 * Collab does that after changing what members may do — archiving, restoring,
 * changing someone's role — and the connection layer re-authenticates on its
 * own. What the page shows about the project (the archived banner, which role
 * gates the chrome) comes from the project query instead, so it has to be
 * asked again or the page keeps showing the state from before the change.
 * Every project document is closed together; the meta document is the one
 * this page always holds, so listening there sees each change once.
 * @param provider - The project's meta document provider, null until it exists.
 * @param projectId - The project.
 */
export function useRefreshOnReauth(provider: HocuspocusProvider | null, projectId: string): void {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (provider === null) return undefined;
    /**
     * Refetch the project when the close asks for a re-check.
     * @param data - The close payload.
     * @param data.event - The close event, carrying its reason.
     */
    const onClose = (data: { event?: { reason?: string } } | undefined): void => {
      if (!isReauthCloseReason(data?.event?.reason)) return;
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    };
    provider.on('close', onClose);
    return () => {
      provider.off('close', onClose);
    };
  }, [provider, projectId, queryClient]);
}
