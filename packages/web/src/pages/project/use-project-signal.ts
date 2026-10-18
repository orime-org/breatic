// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useEffect, useRef } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  ActivityNewSignalSchema,
  CreditsChangedSignalSchema,
  type ACTIVITY_NEW_SIGNAL,
  type CREDITS_CHANGED_SIGNAL,
} from '@breatic/shared';

/** How long a burst of signals (a bulk op emits many) is gathered into one call. */
const COALESCE_MS = 250;

/** The project signals the meta doc carries, by their `t`. */
const SCHEMA_OF = {
  'activity:new': ActivityNewSignalSchema,
  'credits:changed': CreditsChangedSignalSchema,
} as const;

/**
 * Call back when the meta-doc socket carries a project signal.
 *
 * Collab relays `activity:new` whenever a row lands in the project's activity
 * feed and `credits:changed` whenever a charge on its studio commits. A burst
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
  signal: typeof ACTIVITY_NEW_SIGNAL | typeof CREDITS_CHANGED_SIGNAL,
  onSignal: () => void,
): void {
  const latest = useRef(onSignal);
  latest.current = onSignal;

  useEffect(() => {
    if (!provider) return;
    const schema = SCHEMA_OF[signal];
    let debounce: ReturnType<typeof setTimeout> | null = null;
    /**
     * Parse a stateless payload and call back on the signal for this project.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      try {
        const parsed = schema.safeParse(JSON.parse(data.payload));
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
  }, [provider, projectId, signal]);
}
