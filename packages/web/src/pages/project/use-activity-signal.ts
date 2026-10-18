// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useEffect, useRef } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { ActivityNewSignalSchema } from '@breatic/shared';

/** How long a burst of signals (a bulk op emits many) is gathered into one call. */
const COALESCE_MS = 250;

/**
 * Call back when a row lands in this project's activity feed.
 *
 * The meta-doc socket broadcasts `activity:new` whenever a row lands (collab
 * directly; server and worker through the control-plane relay). A burst is
 * coalesced into one call on a short trailing timer. Other stateless traffic
 * on the socket (space RPC answers) is not JSON of this shape and is ignored.
 * @param provider - The live meta-doc provider, or null while there is none.
 * @param projectId - The project whose rows count.
 * @param onSignal - What to do; read on every signal, so it need not be stable.
 */
export function useActivitySignal(
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
  projectId: string,
  onSignal: () => void,
): void {
  const latest = useRef(onSignal);
  latest.current = onSignal;

  useEffect(() => {
    if (!provider) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    /**
     * Parse a stateless payload and call back on a signal for this project.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      try {
        const parsed = ActivityNewSignalSchema.safeParse(JSON.parse(data.payload));
        if (parsed.success && parsed.data.projectId === projectId) {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => latest.current(), COALESCE_MS);
        }
      } catch {
        // Non-JSON stateless traffic (e.g. space RPC responses) — not ours.
      }
    };
    provider.on('stateless', onStateless);
    return (): void => {
      if (debounce) clearTimeout(debounce);
      provider.off('stateless', onStateless);
    };
  }, [provider, projectId]);
}
