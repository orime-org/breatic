// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Make the open Studio's or Project's region the current one while the page
 * is mounted (inner#1955). A layout effect runs before any query effect in
 * the tree, so every request the page and its children send already goes to
 * that region, and its cleanup runs before the next page sets its own.
 */

import * as React from 'react';

import { setCurrentRegion } from '@web/data/api/regions';

/**
 * Hold the current region for the page's lifetime.
 * @param region - The page's region; null is the global region, undefined while unknown.
 */
export function useCurrentRegion(region: string | null | undefined): void {
  React.useLayoutEffect(() => {
    if (region === undefined) return undefined;
    setCurrentRegion(region);
    return () => setCurrentRegion(null);
  }, [region]);
}
