// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Where the last reload is recorded, so the next document can read it. */
const RELOAD_KEY = 'breatic.chunkReload';

/**
 * How close to this document's start a mark has to be to be its own reload.
 *
 * Covers writing the mark, the reload, and the new document reaching the
 * script that reads it. Everything older belongs to an earlier visit.
 */
const RELOAD_WINDOW_MS = 10_000;

/**
 * Take the one reload this tab is allowed, if it is going.
 *
 * The window is measured from `performance.timeOrigin` — when this document
 * started — so a mark written just before it is the reload that produced it,
 * however long this document then takes to reach its own failure. Measuring
 * from the clock instead makes the answer depend on how slow the reader's link
 * is: a document that takes longer than the window to fail claims another
 * reload, and so does the one after it. Measured on a link where the entry
 * bundle took 11s: six documents in sixty seconds, the loading screen up the
 * whole time — the loop this guard exists to stop.
 *
 * Reading and writing are one step because the answer depends on both: a store
 * that cannot be read cannot remember the reload either, and a reload nobody
 * can remember repeats on every document. Letting the error through instead
 * leaves the reader a page they can refresh.
 * @returns True when the caller may reload.
 */
function claimReload(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY));
    if (performance.timeOrigin - last < RELOAD_WINDOW_MS) {
      return false;
    }
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a route's chunk, reloading the page once when the file is no longer there.
 *
 * A reader who keeps a tab open across a deploy holds an `index.html` naming
 * chunks from the previous build, and those files are gone. Reloading fetches
 * the new document, whose names resolve, and lands the reader on the entry
 * they were heading for.
 *
 * One reload per window, counted per tab rather than per chunk, and the mark
 * stands whatever else arrives in the meantime: a second handler reloading on
 * its own is how a refresh loop starts, and inside one window every failure has
 * the same cause anyway. An arrival does not hand the budget back — `/studio`
 * fetches two chunks in one document, so clearing the mark on the first would
 * leave the second free to claim another reload, and the document after it the
 * same (measured: 51 documents in twelve seconds). The cost is one line:
 * a single tab left open across two deploys recovers from the first only.
 * A build that is broken for some other reason — the reader is offline, an
 * extension is blocking the request — fails again on the new document, and that
 * second failure is thrown rather than reloaded on.
 *
 * The error is always re-thrown. The reload takes the document away before
 * React commits anything (measured: the reader sees the loading screen and
 * then the page, with 0, 300 and 800 ms of added latency), and when no reload
 * is going the failure reaches the error boundary instead of leaving them on a
 * loading screen that never resolves.
 * @param load - The dynamic import to run.
 * @returns The module.
 * @throws {unknown} Whatever `load` rejected with.
 */
export async function fetchRouteChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error: unknown) {
    if (claimReload()) {
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
