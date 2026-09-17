// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Chunks that have already spent their one reload, when no store is reachable. */
const spentInThisDocument = new Set<string>();

/** Prefix for the per-chunk marker kept across the reload. */
const SPENT_PREFIX = 'breatic.chunkReload.';

/**
 * Whether this chunk has already been reloaded for.
 *
 * `sessionStorage` throws when site data is blocked; the in-memory set still
 * bounds the reloads within one document, which is the loop worth stopping.
 * @param key - Identifies the chunk.
 * @returns True when a reload has already been spent on it.
 */
function reloadSpent(key: string): boolean {
  if (spentInThisDocument.has(key)) {
    return true;
  }
  try {
    return sessionStorage.getItem(SPENT_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

/**
 * Record that this chunk has spent its reload.
 * @param key - Identifies the chunk.
 */
function markReloadSpent(key: string): void {
  spentInThisDocument.add(key);
  try {
    sessionStorage.setItem(SPENT_PREFIX + key, '1');
  } catch {
    // Nothing to write to. The set above still holds within this document.
  }
}

/**
 * Identify a chunk by the import its factory performs.
 *
 * The compiled factory carries the chunk's file name, which is a content hash,
 * so each route has its own key and a new deploy issues fresh ones. If a
 * bundler ever emits identical bodies the keys collapse and the guard turns
 * coarser — one reload for the lot — which is a bound, not a loop.
 * @param load - The dynamic import to identify.
 * @returns A key for this chunk.
 */
function chunkKey(load: () => Promise<unknown>): string {
  return load.toString();
}

/**
 * Fetch a route's chunk, reloading the page once when the file is no longer there.
 *
 * A reader who keeps a tab open across a deploy holds an `index.html` naming
 * chunks from the previous build, and those files are gone. Reloading fetches
 * the new document, whose names resolve, and lands the reader on the entry
 * they were heading for.
 *
 * One reload per chunk. A chunk that arrives and then throws while evaluating
 * fails the same way after the reload, and asking again would be a loop the
 * reader cannot leave. Keyed per chunk rather than per session because an
 * entry can load several: the three `/studio` addresses fetch a layout and
 * then a page, and one of them succeeding says nothing about the other.
 *
 * The error is always re-thrown. The reload usually takes the document away
 * before anything renders, and when it does not — a `beforeunload` handler is
 * registered and the reader chooses to stay — the failure reaches the error
 * boundary instead of leaving them on a loading screen that never resolves.
 * @param load - The dynamic import to run.
 * @returns The module.
 * @throws {unknown} Whatever `load` rejected with, after asking for a reload
 *   the first time this chunk fails.
 */
export async function fetchRouteChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error: unknown) {
    const key = chunkKey(load);
    if (!reloadSpent(key)) {
      markReloadSpent(key);
      window.location.reload();
    }
    throw error;
  }
}

/**
 * A route's page, fetched when the reader goes there.
 *
 * Every entry goes through here so the recovery above covers all of them: a
 * route written with a bare `lazy(() => import(...))` would look the same and
 * lose it, which `routes-lazy.test.tsx` pins against.
 * @param load - The page module's dynamic import.
 * @returns The lazy component for the route table.
 */
export function lazyRoute<T extends ComponentType<unknown>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() => fetchRouteChunk(load));
}
