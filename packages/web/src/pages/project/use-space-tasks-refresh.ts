// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { SPACE_TASKS_CHANGED_SIGNAL } from '@breatic/shared';
import { spaceTasksQueryKey } from '@web/data/api/scene';

/**
 * Read a Space's task and execution lists again whenever the meta-doc socket
 * says they changed (3D tasks, inner#1690; Timeline and Motion executions,
 * #1490): a row opened, moved, settled, expired on read, or was removed.
 * Every such list is a query keyed under its Space, so a panel that is not open reads
 * the fresh list when it next opens.
 * @param projectId - The project whose signals count.
 * @param provider - The live meta-doc provider, or null while there is none.
 */
export function useSpaceTasksRefresh(
  projectId: string,
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!provider) return;
    /**
     * Parse a stateless payload and invalidate the signalled Space's list.
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
      if (t !== SPACE_TASKS_CHANGED_SIGNAL || about !== projectId || typeof spaceId !== 'string') return;
      void queryClient.invalidateQueries({ queryKey: spaceTasksQueryKey(projectId, spaceId) });
    };
    provider.on('stateless', onStateless);
    return (): void => { provider.off('stateless', onStateless); };
  }, [provider, projectId, queryClient]);
}
