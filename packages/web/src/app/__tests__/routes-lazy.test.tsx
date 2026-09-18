// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type * as React from 'react';
import type { RouteObject } from 'react-router-dom';

import { router } from '@web/app/routes';

const REACT_LAZY = Symbol.for('react.lazy');

/**
 * Whether a route element's component was produced by `React.lazy`.
 *
 * A lazy component is a plain object carrying the `react.lazy` tag, so the
 * check reads the tag rather than the identity of any one page — a new page
 * added tomorrow is covered without touching this file.
 * @param type - The `type` field of a JSX element.
 * @returns True when the component will be fetched on demand.
 */
function isLazy(type: unknown): boolean {
  return (
    typeof type === 'object' &&
    type !== null &&
    (type as { $$typeof?: symbol }).$$typeof === REACT_LAZY
  );
}

/**
 * Whether a lazy component came from `lazyRoute` rather than a bare `lazy`.
 *
 * `lazyRoute` is the only thing that hands a page a `preload`, so the presence
 * of that function is what separates the two at runtime. Both spellings
 * produce the same `react.lazy` tag, so `isLazy` above cannot tell them apart
 * — and the difference is the whole point: a bare `lazy` silently loses the
 * deploy recovery and the head start the router gives the matched branch.
 * @param type - The `type` field of a JSX element.
 * @returns True when the page was declared with `lazyRoute`.
 */
function hasPreload(type: unknown): boolean {
  return typeof (type as { preload?: unknown }).preload === 'function';
}

/**
 * The page component a route renders, looking through any guard wrapper.
 *
 * Seven routes wrap their page in `<ProtectedRoute>`; the page is that
 * element's only child. Redirect-only routes render `<Navigate>` and carry no
 * page, so they answer null.
 * @param element - The route's `element`.
 * @returns The page element, or null when the route only redirects.
 */
function pageElementOf(element: React.ReactNode): React.ReactElement | null {
  if (element === null || typeof element !== 'object' || !('type' in element)) {
    return null;
  }
  const node = element as React.ReactElement<{ children?: React.ReactNode }>;
  const name =
    typeof node.type === 'function'
      ? (node.type as { name?: string }).name
      : undefined;
  if (name === 'Navigate') {
    return null;
  }
  if (name === 'ProtectedRoute') {
    return pageElementOf(node.props.children);
  }
  return node;
}

/**
 * Every production route paired with whether its page is lazily loaded.
 *
 * `/dev/*` is left out: `routes.tsx` mounts it only under
 * `import.meta.env.DEV`, so it never reaches a production bundle and a lazy
 * wrapper there would guard something that does not ship.
 * @param routes - The route objects to walk.
 * @param prefix - The path accumulated from ancestors.
 * @returns One entry per route that renders a page.
 */
function collectPages(
  routes: RouteObject[],
  prefix = '',
): Array<{ path: string; type: unknown }> {
  const found: Array<{ path: string; type: unknown }> = [];
  for (const route of routes) {
    const path =
      route.index === true
        ? prefix || '/'
        : `${prefix}/${route.path ?? ''}`.replace(/\/+/g, '/');
    if (!path.startsWith('/dev/')) {
      // A route written with `Component:` is normalised into `element` when
      // the router is built, so one shape covers both spellings.
      const page = pageElementOf(route.element);
      if (page !== null) {
        found.push({ path, type: page.type });
      }
    }
    if (route.children !== undefined) {
      found.push(...collectPages(route.children, path === '/' ? '' : path));
    }
  }
  return found;
}

describe('route table', () => {
  it('loads every production page on demand', () => {
    const eager = collectPages(router.routes)
      .filter((entry) => !isLazy(entry.type))
      .map((entry) => entry.path);

    expect(eager).toEqual([]);
  });

  it('sends every production page through lazyRoute', () => {
    // A route written as a bare `lazy(() => import(...))` is lazy too, so the
    // check above passes it while the reader loses the deploy recovery and the
    // head start. What tells them apart is the `preload` only `lazyRoute`
    // attaches, which is a fact about the components the table actually built
    // — not about how its source happens to be spelled.
    const bare = collectPages(router.routes)
      .filter((entry) => !hasPreload(entry.type))
      .map((entry) => entry.path);

    expect(bare).toEqual([]);
  });

  it('covers every entry a reader can land on', () => {
    // Guards the check above against a route table that shrank: an empty list
    // of eager pages also describes a table with no pages at all.
    expect(collectPages(router.routes).map((entry) => entry.path).sort()).toEqual(
      [
        '/choose-slug',
        '/decision',
        '/forgot-password',
        '/login',
        '/project/:projectId',
        '/project/:projectId/access',
        '/recovery-code',
        '/register',
        '/reset-password',
        '/studio',
        '/studio',
        '/studio/:slug',
        '/studio/:slug/:tab',
        '/verify-email',
      ].sort(),
    );
  });
});
