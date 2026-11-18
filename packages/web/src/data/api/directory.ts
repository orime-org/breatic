// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which region a Studio or Project lives in, from the global directory
 * (inner#1955). The directory hears of a non-global region's new Project or
 * new slug through that region's outbox a moment after the change, so the tab
 * that made the change answers from what it already knows. Every answer is
 * remembered (`rememberProjectRegion`, `rememberStudioRegion`), and requests
 * acting on that Project or Studio go to its region from then on. A slug can
 * later belong to another Studio and is asked again on each page; this tab's
 * own rename is written into the switcher's list, which the Studio page reads
 * first.
 */

import { projectRegionOf, rememberProjectRegion, rememberStudioRegion } from '@web/data/api/regions';
import { apiGet } from '@web/data/api/request';

/** Where a Studio or Project lives; null is the global region. */
export interface DirectoryEntry {
  region: string | null;
}

export const directoryApi = {
  /**
   * The region of a Studio.
   * @param slug - The Studio's slug.
   * @returns Its region.
   * @throws {ApiException} When the directory does not answer.
   */
  async studio(slug: string): Promise<DirectoryEntry> {
    const entry = await apiGet<DirectoryEntry>(`/directory/studios/${encodeURIComponent(slug)}`);
    rememberStudioRegion([slug], entry.region);
    return entry;
  },

  /**
   * The region of a Project.
   * @param id - The Project id.
   * @returns Its region.
   * @throws {ApiException} When the directory does not answer.
   */
  async project(id: string): Promise<DirectoryEntry> {
    const remembered = projectRegionOf(id);
    if (remembered !== undefined) return { region: remembered };
    const entry = await apiGet<DirectoryEntry>(`/directory/projects/${encodeURIComponent(id)}`);
    rememberProjectRegion(id, entry.region);
    return entry;
  },
};
