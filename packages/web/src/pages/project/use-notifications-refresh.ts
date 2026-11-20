// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { NOTIFICATIONS_CHANGED_SIGNAL } from '@breatic/shared';

/**
 * Keep the bell current on the project page (#1488 §11.9): read the
 * notifications again when collab says the user's changed, and once the
 * project connection is synced again, which covers what changed while it was
 * down.
 * @param provider - The project meta doc's provider.
 */
export function useNotificationsRefresh(provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!provider) return;
    /** Read the bell again. */
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    /**
     * Read the bell again on collab's signal.
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
      if ((parsed as { t?: unknown } | null)?.t === NOTIFICATIONS_CHANGED_SIGNAL) refresh();
    };
    provider.on('stateless', onStateless);
    provider.on('synced', refresh);
    return (): void => {
      provider.off('stateless', onStateless);
      provider.off('synced', refresh);
    };
  }, [provider, queryClient]);
}
