// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { captureException } from '@sentry/react';
import { RouteErrorReportContext, type RouteErrorReport } from '@web/app/RouteErrorPage';
import { configuredErrorEventId } from '@web/lib/error-monitoring';
import { RouterProvider } from 'react-router-dom';

interface AppRouterProps {
  /** The data router to render. */
  router: React.ComponentProps<typeof RouterProvider>['router'];
}

/**
 * The router, with nothing above it that can hide it.
 *
 * The loading screen every entry waits behind is a route rather than a wrapper
 * here — see `behindLoadingScreen`, which explains why the boundary has to sit
 * under the provider.
 *
 * `useTransitions={false}` is what makes that boundary answer on navigation
 * and not only on the first mount. Left undefined, the router wraps its state
 * updates in `React.startTransition`, and React holds already revealed content
 * on screen for the length of a suspended transition — so following a link
 * would leave the reader on the page they were leaving until the next chunk
 * arrived.
 * @param root0 - The component props.
 * @param root0.router - The data router to render.
 * @returns The router.
 * @throws {Error} If the router cannot render or error capture fails.
 */
export function AppRouter({ router }: AppRouterProps): React.JSX.Element {
  const [report, setReport] = React.useState<RouteErrorReport>();
  const reportRouteError = React.useCallback((error: unknown): void => {
    const eventId = captureException(error, { tags: { error_boundary: 'route' } });
    setReport({ error, eventId: configuredErrorEventId(eventId) });
  }, []);
  return (
    <RouteErrorReportContext.Provider value={report}>
      <RouterProvider router={router} useTransitions={false} onError={reportRouteError} />
    </RouteErrorReportContext.Provider>
  );
}
