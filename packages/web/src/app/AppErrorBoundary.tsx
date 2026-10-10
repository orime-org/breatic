// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';
import { configuredErrorEventId } from '@web/lib/error-monitoring';
import { ErrorBoundary, type FallbackRender, type Scope } from '@sentry/react';
import { ApplicationErrorPage } from '@web/components/application-error-page';

/**
 * Identify failures outside the route and component-specific boundaries.
 * @param scope - The SDK's isolated capture scope.
 * @throws {Error} If the monitoring SDK cannot annotate the event.
 */
function tagApplicationError(scope: Scope): void {
  scope.setTag('error_boundary', 'application');
}

/**
 * Render recovery using only the identifier returned for this exception.
 * @param report - Sentry's captured boundary report.
 * @param report.eventId - Identifier associated with this error.
 * @returns A recovery page independent of application providers.
 * @throws {Error} If React cannot render recovery.
 */
const renderApplicationError: FallbackRender = ({ eventId }): React.JSX.Element => (
  <ApplicationErrorPage eventId={configuredErrorEventId(eventId)} />
);

/**
 * Contain application render/effect errors that do not reach a route boundary.
 * @param props - The application subtree.
 * @param props.children - Providers and the router.
 * @returns The application or its localized full-document recovery.
 * @throws {Error} If the recovery subtree itself fails.
 */
export function AppErrorBoundary({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <ErrorBoundary beforeCapture={tagApplicationError} fallback={renderApplicationError}>{children}</ErrorBoundary>;
}
