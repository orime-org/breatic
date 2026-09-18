// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Outlet, type RouteObject } from 'react-router-dom';

import { LoadingScreen } from '@web/components/loading-screen';

/**
 * The one screen every entry waits behind.
 *
 * One `Suspense` boundary for the whole table: the entries cannot drift into
 * showing different waiting screens, because there is only one to show.
 * @returns The matched entry, or the loading screen while its chunk is on its way.
 */
export function LoadingBoundary(): React.JSX.Element {
  return (
    <React.Suspense fallback={<LoadingScreen />}>
      <Outlet />
    </React.Suspense>
  );
}

// The preload gate reads this: every route matches this element, and it is the
// one wrapper in the table that decides nothing about whether a page renders.
// Without it the gate cannot tell this shape from `<Guard><Outlet/></Guard>`
// and withholds the whole table from a reader with no session yet.
LoadingBoundary.rendersEveryChild = true;

/**
 * Put every route behind the one loading screen, inside the router.
 *
 * The boundary is a route rather than a wrapper around `RouterProvider`
 * because React destroys the effects of whatever a boundary hides: above the
 * provider, its subscription to the router dies for the length of every chunk
 * wait, and a reader who navigates during that wait is not followed. Measured
 * on the production build with a chunk that took four seconds and succeeded —
 * Back moved the address bar to /studio while the project page arrived behind
 * it and stayed. As a route the provider is above the boundary and keeps
 * listening; only the matched entry is hidden.
 * @param routes - The route table.
 * @returns The same table, as children of the boundary.
 */
export function behindLoadingScreen(routes: RouteObject[]): RouteObject[] {
  return [{ element: <LoadingBoundary />, children: routes }];
}
