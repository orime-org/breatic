// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  Children,
  createElement,
  isValidElement,
  lazy,
  useEffect,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
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
 * Take the one reload this tab is allowed, if it is going.
 *
 * A mark of any age means the budget is spent: the only thing that clears it
 * is a page reaching the screen (`returnBudget`), and the mark lives in
 * session storage, so a mark that is still here belongs to a tab that has not
 * shown a page since it reloaded. Its age says nothing further — an age limit
 * would hand a second reload to a tab that is failing slowly, which on a link
 * where the entry bundle took 11s meant six documents in sixty seconds with
 * the loading screen up the whole time.
 *
 * Reading and writing are one step because the answer depends on both: a store
 * that cannot be read cannot remember the reload either, and a reload nobody
 * can remember repeats on every document. Letting the error through instead
 * leaves the reader a page they can refresh.
 * @returns True when the caller may reload.
 */
function claimReload(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY) !== null) {
      return false;
    }
    sessionStorage.setItem(RELOAD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Give the tab its reload back — design §6.1, `SPENT × PAGE_ON_SCREEN`.
 *
 * This is the only transition out of `SPENT`, and the signal has to be a page
 * module reaching the screen. Two cheaper signals were measured and both are
 * wrong: the boundary committing fires while `ProtectedRoute` shows its own
 * screen for the auth ping, before the page module is asked for; and any fixed
 * number of seconds is exceeded by a slow link, where a loop iteration was
 * measured at eleven seconds.
 */
function returnBudget(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Wrap a page so that reaching the screen hands the reload budget back.
 *
 * The effect belongs to the page itself: a boundary commits its children
 * together, so this cannot run while `/studio`'s second chunk is still on its
 * way, and it cannot run at all while a guard is rendering a screen instead of
 * this page.
 * @param Page - The page component the chunk resolved to.
 * @returns The same page, reporting that it reached the reader.
 */
function reportingOnScreen<T extends ComponentType<unknown>>(Page: T): T {
  /**
   * The page, plus the effect that says it reached the reader.
   * @param props - Whatever the route passes the page.
   * @returns The page.
   */
  function PageOnScreen(props: Record<string, unknown>): ReactElement {
    useEffect(returnBudget, []);
    return createElement(Page, props);
  }
  return PageOnScreen as unknown as T;
}

/**
 * Fetch a route's chunk, reloading the page once when the file is no longer there.
 *
 * A reader who keeps a tab open across a deploy holds an `index.html` naming
 * chunks from the previous build, and those files are gone. Reloading fetches
 * the new document, whose names resolve, and lands the reader on the entry
 * they were heading for.
 *
 * One reload per document, counted per tab rather than per chunk, and a chunk
 * arriving does not hand it back: a second handler reloading on its own is how
 * a refresh loop starts, and inside one document every failure has the same
 * cause anyway. What bounds the loop is that a document which never shows a
 * page never gets another reload — a build that keeps failing, because the
 * reader is offline or an extension is blocking the request, reaches the error
 * boundary on the second document rather than starting a third.
 *
 * A page reaching the screen is what hands it back (`reportingOnScreen`), and
 * that is the whole of design §6.1's `SPENT → FRESH`. It is also the only
 * thing that hands it back: a tab that reloaded and has shown a page since
 * meets the next deploy with a full budget, and one that has shown nothing
 * meets it on the error screen, which is where a loop has to end.
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

/** What a route's element holds, read in one walk. */
interface Branch {
  /** Every page under the element, ready to start its own download. */
  pages: Array<() => void>;
  /** Whether something stands between the address and one of those pages. */
  guarded: boolean;
}

/**
 * Read a route's element: the pages it holds, and whether anything gates them.
 *
 * The walk looks for the `preload` a page carries rather than for the wrappers
 * around it, so a guard that shows its own screen instead of its children —
 * which is what keeps the page from rendering, and therefore from asking for
 * its own module — hides nothing.
 *
 * `guarded` is that same fact read the other way: an element that is not a
 * page but holds one decides whether that page renders at all. Something
 * holding no page decides nothing, which is why the loading boundary every
 * route sits under does not read as a guard.
 * @param node - A route's element, or anything under it.
 * @returns The pages found, and whether one of them is gated.
 */
function branchOf(node: ReactNode): Branch {
  const pages: Array<() => void> = [];
  let guarded = false;
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) {
      return;
    }
    const preload = (child.type as Preloadable).preload;
    if (preload !== undefined) {
      pages.push(preload);
      return;
    }
    const inner = branchOf((child.props as { children?: ReactNode }).children);
    pages.push(...inner.pages);
    guarded = guarded || inner.guarded || inner.pages.length > 0;
  });
  return { pages, guarded };
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
 * gate": the walk runs before `/auth/me` can say, and a page behind the gate is
 * one a signed-out visitor is about to be bounced away from. Measured on a
 * 4 Mbps link, walking past the gate for a visitor with no session put the
 * sign-in field on screen 502 ms later, behind 2.4 MB of canvas they never saw.
 *
 * With the gate shut the question is asked of the branch, not of each element
 * (design §6.3): a layout route's children render inside its Outlet and carry
 * no wrapper of their own, so asking per element withholds the root of the
 * branch and fetches the leaf — which cannot render without it anyway.
 * @param matches - What the router matched the address to.
 * @param pastGuards - Whether to reach pages that sit behind a guard.
 */
export function preloadMatched(
  matches: readonly MatchedRoute[],
  pastGuards: boolean,
): void {
  const branches = matches.map((match) => branchOf(match.route.element));
  if (!pastGuards && branches.some((branch) => branch.guarded)) {
    return;
  }
  for (const branch of branches) {
    for (const preload of branch.pages) {
      preload();
    }
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
  const Page = lazy(async () => {
    const mod = await fetchRouteChunk(load);
    return { default: reportingOnScreen(mod.default) };
  }) as LazyExoticComponent<T> & Preloadable;
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
