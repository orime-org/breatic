// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';

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
): Array<{ path: string; lazy: boolean }> {
  const found: Array<{ path: string; lazy: boolean }> = [];
  for (const route of routes) {
    const path =
      route.index === true
        ? prefix || '/'
        : `${prefix}/${route.path ?? ''}`.replace(/\/+/g, '/');
    if (!path.startsWith('/dev/')) {
      const page = pageElementOf(route.element);
      if (page !== null) {
        found.push({ path, lazy: isLazy(page.type) });
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
      .filter((entry) => !entry.lazy)
      .map((entry) => entry.path);

    expect(eager).toEqual([]);
  });

  it('sends every production page through lazyRoute', () => {
    // A route written as a bare `lazy(() => import(...))` looks the same, loads
    // the same, and silently loses the recovery a reader needs after a deploy.
    // The table is the one place that decides this, so the check reads it.
    // vitest runs from the package root, and the route table is the file this
    // rule belongs to.
    const source = readFileSync('src/app/routes.tsx', 'utf8');
    const wrapped = source.match(/=\s*lazyRoute\(/g) ?? [];
    const bare = source.match(/=\s*lazy\(/g) ?? [];

    expect(wrapped).toHaveLength(collectPages(router.routes).length - 1);
    // The dev gallery is the one bare `lazy`: its route is mounted only under
    // `import.meta.env.DEV`, so it never ships and needs no deploy recovery.
    expect(bare).toHaveLength(1);
    expect(source).toContain(
      'const PrimitivesGallery = lazy(() => import(\'@web/pages/_dev/PrimitivesGallery\'));',
    );
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
