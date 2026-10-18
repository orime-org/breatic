// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useEffect, useRef } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { ActivityNewSignal, CreditsChangedSignal } from '@breatic/shared';

/** How long a burst of signals (a bulk op emits many) is gathered into one call. */
const COALESCE_MS = 250;

/**
 * Call back when the meta-doc socket carries a project signal.
 *
 * Collab relays `activity:new` whenever a row lands in the project's activity
 * feed and `credits:changed` whenever a charge made in the project commits. A burst
 * is coalesced into one call on a short trailing timer. Other stateless
 * traffic on the socket (space RPC answers) does not parse as the signal and
 * is ignored.
 * @param provider - The live meta-doc provider, or null while there is none.
 * @param projectId - The project whose signals count.
 * @param signal - Which signal to listen for.
 * @param onSignal - What to do; read on every signal, so it need not be stable.
 */
export function useProjectSignal(
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
  projectId: string,
  signal: ActivityNewSignal['t'] | CreditsChangedSignal['t'],
  onSignal: () => void,
): void {
  const latest = useRef(onSignal);
  latest.current = onSignal;

  useEffect(() => {
    if (!provider) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    /**
     * Parse a stateless payload and call back on the signal for this project.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      try {
        const parsed: unknown = JSON.parse(data.payload);
        const { t, projectId: about } = (parsed ?? {}) as { t?: unknown; projectId?: unknown };
        if (t === signal && about === projectId) {
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
  }, [provider, projectId, signal]);
}
