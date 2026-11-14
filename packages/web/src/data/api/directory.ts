// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which region a Studio or Project lives in, from the global directory
 * (inner#1955). The directory hears of a non-global region's new Project or
 * new slug through that region's outbox a moment after the change, so the tab
 * that made the change answers from what it already knows. A Project id never
 * changes, so its region is kept in localStorage and a reopened page skips the
 * question. A slug can later belong to another Studio and is always asked;
 * this tab's own rename is written into the switcher's list, which the
 * Studio page reads first.
 */

import { apiGet } from '@web/data/api/request';

/** Where a Studio or Project lives; null is the global region. */
export interface DirectoryEntry {
  region: string | null;
}

const PROJECT_CACHE_PREFIX = 'breatic:region:project:';

/**
 * Remember the region of a Project this tab just created.
 * @param id - The Project id.
 * @param region - Its region; null is the global region.
 */
export function rememberProjectRegion(id: string, region: string | null): void {
  try {
    window.localStorage.setItem(PROJECT_CACHE_PREFIX + id, region ?? '');
  } catch {
    // Storage unavailable: the directory answers once it has heard.
  }
}

export const directoryApi = {
  /**
   * The region of a Studio.
   * @param slug - The Studio's slug.
   * @returns Its region.
   * @throws {ApiException} When the directory does not answer.
   */
  async studio(slug: string): Promise<DirectoryEntry> {
    return apiGet<DirectoryEntry>(`/directory/studios/${encodeURIComponent(slug)}`);
  },

  /**
   * The region of a Project.
   * @param id - The Project id.
   * @returns Its region.
   * @throws {ApiException} When the directory does not answer.
   */
  async project(id: string): Promise<DirectoryEntry> {
    try {
      const remembered = window.localStorage.getItem(PROJECT_CACHE_PREFIX + id);
      if (remembered !== null) return { region: remembered === '' ? null : remembered };
    } catch {
      // Storage unavailable: ask the directory.
    }
    const entry = await apiGet<DirectoryEntry>(`/directory/projects/${encodeURIComponent(id)}`);
    rememberProjectRegion(id, entry.region);
    return entry;
  },
};
