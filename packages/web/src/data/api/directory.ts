// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which region a Studio or Project lives in, from the global directory
 * (inner#1955), remembered in localStorage so a reopened page skips the
 * question.
 */

import { apiGet } from '@web/data/api/request';

/** Where a Studio or Project lives; null is the global region. */
export interface DirectoryEntry {
  region: string | null;
}

const CACHE_PREFIX = 'breatic:region:';

/**
 * Read a remembered region, or ask the directory and remember the answer.
 * @param key - The cache key.
 * @param path - The directory path to ask.
 * @returns The entry.
 * @throws {ApiException} When the directory does not answer.
 */
async function lookup(key: string, path: string): Promise<DirectoryEntry> {
  try {
    const remembered = window.localStorage.getItem(CACHE_PREFIX + key);
    if (remembered !== null) return { region: remembered === '' ? null : remembered };
  } catch {
    // Storage unavailable: ask the directory.
  }
  const entry = await apiGet<DirectoryEntry>(path);
  try {
    window.localStorage.setItem(CACHE_PREFIX + key, entry.region ?? '');
  } catch {
    // Storage unavailable: the next open asks again.
  }
  return entry;
}

export const directoryApi = {
  /**
   * The region of a Studio.
   * @param slug - The Studio's slug.
   * @returns Its region.
   */
  studio(slug: string): Promise<DirectoryEntry> {
    return lookup(`studio:${slug}`, `/directory/studios/${encodeURIComponent(slug)}`);
  },

  /**
   * The region of a Project.
   * @param id - The Project id.
   * @returns Its region.
   */
  project(id: string): Promise<DirectoryEntry> {
    return lookup(`project:${id}`, `/directory/projects/${encodeURIComponent(id)}`);
  },
};
