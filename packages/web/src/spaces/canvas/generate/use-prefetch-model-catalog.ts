// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Warming the model catalog when a canvas space opens (#1966).
 *
 * The Generate panel now waits for the catalog before it renders anything
 * (#1964), which is right — every control in it needs the catalog to say
 * anything true — but it would turn the first Generate of a session into a
 * visible wait. Fetching when the space mounts moves that request to a moment
 * nobody is watching, so by the time someone clicks Generate the answer is
 * usually already in the cache the gate reads.
 *
 * Here rather than at app startup: the catalog is the Generate panel's, and
 * the Generate panel is the canvas space's. A studio listing that fetches it
 * spends a request on something that page cannot use.
 */

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';

/**
 * Prefetch the model catalog once for this mount.
 *
 * `prefetchQuery`, deliberately, not `useQuery`:
 *
 * It registers no observer. A `useQuery` here would hold one for as long as
 * the space stays open, which would keep the cache entry alive indefinitely —
 * garbage collection only starts once the last observer unmounts — and the
 * catalog would stop ageing out the way every other query does.
 *
 * It also swallows failures. That is the documented contract (the prefetch
 * helpers "never throw errors because they usually try to fetch again in a
 * `useQuery`"), and it is the behaviour this call wants: nobody is waiting on
 * a warm-up, so nobody should be interrupted when one fails. The gate's own
 * `useQuery` retries when a panel actually opens, and THAT failure is the one
 * the user hears about.
 */
export function usePrefetchModelCatalog(): void {
  const queryClient = useQueryClient();
  React.useEffect(() => {
    void queryClient.prefetchQuery(modelCatalogQuery());
  }, [queryClient]);
}
