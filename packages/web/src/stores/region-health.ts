// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which regions did not answer the global region's last gathering
 * (inner#1955). The bell's poll and the recent feed each report what they
 * saw; the switcher marks the Studios of any region either reported.
 */

import { create } from 'zustand';

/** Where a report came from; each replaces only its own last report. */
export type RegionHealthSource = 'bell' | 'recent';

interface RegionHealthState {
  bySource: Record<RegionHealthSource, readonly string[]>;
  /**
   * Record the regions one gathering found unavailable.
   * @param source - Which gathering.
   * @param regions - The regions that did not answer.
   */
  report: (source: RegionHealthSource, regions: readonly string[]) => void;
}

export const useRegionHealthStore = create<RegionHealthState>((set) => ({
  bySource: { bell: [], recent: [] },
  report: (source, regions) =>
    set((state) => ({ bySource: { ...state.bySource, [source]: regions } })),
}));

/**
 * Whether the last gatherings found a region unavailable.
 * @param region - The region code; null is the global region, which is never reported.
 * @returns True when any source reported it.
 */
export function useRegionUnavailable(region: string | null): boolean {
  return useRegionHealthStore(
    (state) => region !== null && (state.bySource.bell.includes(region) || state.bySource.recent.includes(region)),
  );
}
