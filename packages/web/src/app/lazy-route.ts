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

import { PageUnavailableScreen } from '@web/components/page-unavailable-screen';

/** A route's page, able to start its own download before it renders. */
type Preloadable = { preload?: () => void };

/**
 * A wrapper that renders whatever it is handed, deciding nothing.
 *
 * The preload gate asks whether a page might not render for this reader. It
 * cannot read that off the element tree — a guard is written
 * `<Guard><Outlet/></Guard>` and the loading boundary is the same shape — so
 * the one wrapper that decides nothing says so about itself. Anything that
 * does not say so is a guard, which is the side that costs a round trip
 * rather than a download the reader is about to be bounced away from.
 */
type Transparent = { rendersEveryChild?: boolean };

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
 * `guarded` is the other question, and the element tree cannot answer it: a
 * layout route's guard is `<Guard><Outlet/></Guard>`, whose own children hold
 * no page, and the loading boundary has that same shape. So every wrapper
 * counts as a guard except the one that declares it renders every child.
 * @param node - A route's element, or anything under it.
 * @returns The pages found, and whether anything stands between them and the address.
 */
function branchOf(node: ReactNode): Branch {
  const pages: Array<() => void> = [];
  let guarded = false;
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) {
      return;
    }
    const type = child.type as Preloadable & Transparent;
    if (type.preload !== undefined) {
      pages.push(type.preload);
      return;
    }
    const inner = branchOf((child.props as { children?: ReactNode }).children);
    pages.push(...inner.pages);
    guarded = guarded || inner.guarded || type.rendersEveryChild !== true;
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
 * (design §6.2): a layout route's children render inside its Outlet and carry
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
 * A chunk the browser cannot fetch — commonly because the reader kept this
 * tab open across a deploy, and their `index.html` names files from the
 * previous build — is handled here rather than thrown, so the router's
 * default error element and its JS stack stay out of it. **Nothing reloads
 * the tab** (user 2026-09-18, design §7.3): a refresh is the reader's to
 * press, on every route.
 *
 * What they get depends on where they were going. The editing surface says
 * the page did not load and offers the button, because a reader heading into
 * their work has to know why they cannot get in. Every other entry reads like
 * an ordinary web page: it does not arrive, and the reader refreshes if they
 * want to.
 *
 * Once either has happened, this entry stays that way for the life of the
 * document — `React.lazy` holds its payload, and the browser's module map
 * records a failed fetch permanently. Every other page already in hand keeps
 * working.
 *
 * Every entry goes through here, which `routes-lazy.test.tsx` pins: a route
 * written with a bare `lazy(() => import(...))` would look the same in the
 * table and would drop the reader on the error element instead.
 * @param load - The page module's dynamic import.
 * @param options - How this entry behaves when its chunk is gone.
 * @param options.editingSurface - True for the page the reader works in,
 *   which is the one that speaks when its code does not arrive.
 * @returns The lazy component for the route table.
 */
export function lazyRoute<T extends ComponentType<unknown>>(
  load: () => Promise<{ default: T }>,
  { editingSurface = false }: { editingSurface?: boolean } = {},
): LazyExoticComponent<T> {
  const Page = lazy(() =>
    load().catch(() => {
      if (editingSurface) {
        return { default: PageUnavailableScreen as unknown as T };
      }
      // Stays suspended: the entry does not arrive, and refreshing is the
      // reader's to press.
      return new Promise<{ default: T }>(() => {});
    }),
  ) as LazyExoticComponent<T> & Preloadable;
  // The bundler hands the same promise back for a module already asked for, so
  // the render that follows waits on this request rather than making a second.
  // A rejection here reaches the reader through that render, where the factory
  // above turns it into the notice; swallowing it at this end keeps a preload
  // nobody awaits from surfacing as an unhandled rejection.
  Page.preload = (): void => {
    void load().catch(() => undefined);
  };
  return Page;
}
