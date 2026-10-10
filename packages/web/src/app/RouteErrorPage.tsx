// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useRouteError } from 'react-router-dom';
import { ApplicationErrorPage } from '@web/components/application-error-page';

/** A report owned by one mounted AppRouter; not a cross-page event store. */
export interface RouteErrorReport {
  error: unknown;
  eventId: string | undefined;
}

export const RouteErrorReportContext = React.createContext<RouteErrorReport | undefined>(undefined);

/**
 * Render route recovery without repeating RouterProvider.onError's capture.
 * @returns A localized recovery page with the ID for this exact route error.
 * @throws {Error} If React cannot render recovery.
 */
export function RouteErrorPage(): React.JSX.Element {
  const error = useRouteError();
  const report = React.useContext(RouteErrorReportContext);
  return <ApplicationErrorPage eventId={report && report.error === error ? report.eventId : undefined} />;
}
