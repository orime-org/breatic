// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { ASSIGNMENTS_CHANGED_SIGNAL } from '@breatic/shared';
import { commentAssignmentsKey } from '@web/data/api/agent-access';

/**
 * Keep the hand-over labels on comment threads current (#1488 §11.7): read a
 * Space's records again when the server says they changed, and every Space's
 * once the project connection is synced again, which covers what changed
 * while it was down.
 * @param projectId - The project.
 * @param provider - The project meta doc's provider.
 */
export function useCommentAssignmentsRefresh(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!provider) return;
    /**
     * Read the signalled Space's records again.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.payload);
      } catch {
        // Non-JSON stateless traffic (space RPC answers) is not this signal.
        return;
      }
      const { t, projectId: about, spaceId } = (parsed ?? {}) as { t?: unknown; projectId?: unknown; spaceId?: unknown };
      if (t !== ASSIGNMENTS_CHANGED_SIGNAL || about !== projectId || typeof spaceId !== 'string') return;
      void queryClient.invalidateQueries({ queryKey: commentAssignmentsKey(projectId, spaceId) });
    };
    /** Read every Space's records again after the connection came back. */
    const onSynced = (): void => {
      void queryClient.invalidateQueries({ queryKey: commentAssignmentsKey(projectId) });
    };
    provider.on('stateless', onStateless);
    provider.on('synced', onSynced);
    return (): void => {
      provider.off('stateless', onStateless);
      provider.off('synced', onSynced);
    };
  }, [provider, projectId, queryClient]);
}
