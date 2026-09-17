// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Marks that a reload has already been spent on a chunk this session. */
const RELOAD_SPENT = 'breatic.chunkReloadSpent';

/**
 * Read the session marker, treating an unreachable store as "not spent".
 *
 * `sessionStorage` throws when site data is blocked, and a reader in that
 * state should still get the one reload that recovers a stale deploy.
 * @returns Whether a reload has already been spent this session.
 */
function reloadSpent(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_SPENT) !== null;
  } catch {
    return false;
  }
}

/**
 * Record whether a reload has been spent, ignoring an unreachable store.
 * @param spent - True after asking for a reload, false once a chunk arrives.
 */
function setReloadSpent(spent: boolean): void {
  try {
    if (spent) {
      sessionStorage.setItem(RELOAD_SPENT, '1');
    } else {
      sessionStorage.removeItem(RELOAD_SPENT);
    }
  } catch {
    // Nothing to record. The guard below falls back to reloading, which is
    // the behaviour a reader wants for the case this exists to fix.
  }
}

/**
 * Fetch a route's module, reloading the page when the file is no longer there.
 *
 * A reader who keeps a tab open across a deploy holds an `index.html` naming
 * chunks from the previous build, and those files are gone. Reloading fetches
 * the new document, whose names resolve, and lands the reader on the entry
 * they were heading for.
 *
 * One reload per session. A chunk that arrives and then throws while
 * evaluating fails again after the reload, and reloading on that would be a
 * loop the reader cannot leave; the second failure goes to the error boundary
 * instead. A chunk that does arrive clears the marker, so a later deploy in
 * the same session still gets its reload.
 *
 * Scoped to route chunks on purpose. Vite offers a `vite:preloadError` event
 * on `window`, but it covers every dynamic import in the app — including the
 * document parsers the canvas loads on demand, whose failures belong to the
 * one node the file was dropped on and must not take the page down with them.
 * @param load - The dynamic import to run.
 * @returns The module, or a promise that never settles because a reload is on
 *   its way and an error screen must not flash in the meantime.
 * @throws {unknown} Whatever `load` rejected with, once this session has
 *   already spent its reload.
 */
export async function reloadOnStaleChunk<T>(
  load: () => Promise<T>,
): Promise<T> {
  try {
    const loaded = await load();
    setReloadSpent(false);
    return loaded;
  } catch (error: unknown) {
    if (reloadSpent()) {
      throw error;
    }
    setReloadSpent(true);
    window.location.reload();
    return await new Promise<T>(() => {});
  }
}
