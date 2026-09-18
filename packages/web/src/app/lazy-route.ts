// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Children,
  isValidElement,
  lazy,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from 'react';

/** A route's page, able to start its own download before it renders. */
type Preloadable = { preload?: () => void };

/**
 * One entry of what the router matched the current address to.
 *
 * Only `element` is read: a route written with `Component:` is normalised into
 * `element` during route conversion, so by the time a match exists there is one
 * shape to walk.
 */
interface MatchedRoute {
  route: { element?: ReactNode };
}

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
 * the same cause anyway. Nothing hands the budget back, which is what bounds
 * the loop: a build that keeps failing — the reader is offline, an extension is
 * blocking the request, a chunk that parses and then throws — fails again on
 * the new document, and that second failure reaches the error boundary rather
 * than starting another reload.
 *
 * The bound costs one thing, and it is the right thing to pay: a tab left open
 * across two deploys recovers from the first on its own and asks the reader to
 * refresh for the second. Handing the budget back needs a signal that says a
 * page reached the reader, and the boundary committing is not that signal —
 * `ProtectedRoute` answers the auth ping with a screen of its own, which
 * commits with nothing suspended under it while the page module has not even
 * been asked for yet.
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
  // Where the reader was when this fetch started. `React.lazy` keeps an
  // abandoned payload alive, so a chunk they walked away from still settles
  // here — and reloading then takes away the page they went back to and spends
  // the one reload the next deploy needs.
  const asked = window.location.href;
  try {
    return await load();
  } catch (error: unknown) {
    if (window.location.href === asked && claimReload()) {
      window.location.reload();
    }
    throw error;
  }
}

/**
 * Start the download of every page an element tree holds.
 *
 * The walk looks for the `preload` a page carries rather than for the wrappers
 * around it, so a guard that shows its own screen instead of its children —
 * which is what keeps the page from rendering, and therefore from asking for
 * its own module — hides nothing. That reach is what `pastGuards` decides:
 * with it off, the walk stops at the first wrapper and only a page the address
 * reaches directly is started.
 * @param node - A route's element, or anything under it.
 * @param pastGuards - Whether to keep walking through wrapper components.
 */
function preloadIn(node: ReactNode, pastGuards: boolean): void {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) {
      return;
    }
    const preload = (child.type as Preloadable).preload;
    if (preload !== undefined) {
      preload();
      return;
    }
    if (pastGuards) {
      preloadIn((child.props as { children?: ReactNode }).children, true);
    }
  });
}

/**
 * Start the modules for the whole branch the address matched.
 *
 * Nothing a page chunk needs comes out of `/auth/me`, and nothing an index
 * child needs comes out of its layout's chunk. Left to rendering alone each of
 * those becomes a round trip the reader waits through in turn; asking for them
 * the moment the router knows the match makes them one.
 *
 * `pastGuards` is the caller's answer to "will this reader get past the auth
 * gate": the walk runs before `/auth/me` can say, and a page behind the gate
 * is one a signed-out visitor is about to be bounced away from. Measured on a
 * 4 Mbps link, walking past the gate for a visitor with no session put the
 * sign-in field on screen 502 ms later, behind 2.4 MB of canvas they never
 * saw.
 * @param matches - What the router matched the address to.
 * @param pastGuards - Whether to reach pages that sit behind a guard.
 */
export function preloadMatched(
  matches: readonly MatchedRoute[],
  pastGuards: boolean,
): void {
  for (const match of matches) {
    preloadIn(match.route.element, pastGuards);
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
  const Page = lazy(() => fetchRouteChunk(load)) as LazyExoticComponent<T> &
    Preloadable;
  // The bundler hands the same promise back for a module already asked for, so
  // the render that follows waits on this request rather than making a second.
  // A rejection here reaches the reader through that render, where the
  // recovery above reads it; swallowing it at this end keeps a preload nobody
  // awaits from surfacing as an unhandled rejection.
  Page.preload = (): void => {
    void load().catch(() => undefined);
  };
  return Page;
}
