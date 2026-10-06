// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { BrowserOptions, ErrorEvent } from '@sentry/react';
import {
  errorMonitoringDataCollection,
  errorMonitoringEnvironmentName,
  errorMonitoringRelease,
} from '@breatic/shared';

/** What the build hands error monitoring. */
export interface ErrorMonitoringBuild {
  /** `VITE_SENTRY_DSN`; blank or absent turns reporting off. */
  dsn: string | undefined;
  /** Vite's `MODE`. */
  mode: string;
  /** `VITE_APP_VERSION`, the commit the build was made from. */
  version: string | undefined;
}

/** Browser errors that name no fault of ours. */
const IGNORED_ERRORS: readonly string[] = [
  'ResizeObserver loop limit exceeded',
  'Script error.',
  'NetworkError when attempting to fetch resource',
];

/**
 * Drop an event whose message is browser noise.
 * @param event - The event about to be sent.
 * @returns The event, or `null` to drop it.
 */
function dropBrowserNoise(event: ErrorEvent): ErrorEvent | null {
  const message = event.exception?.values?.[0]?.value ?? '';
  return IGNORED_ERRORS.some((ignored) => message.includes(ignored)) ? null : event;
}

/**
 * The options the web app starts error monitoring with.
 *
 * The release is the build's commit, the same value the backend and the
 * ingest Worker report, so one Sentry release spans all three; a build
 * without a full commit reports none. A mode outside the shared environment
 * names reports as `development`.
 * @param build - DSN, mode and version from the build's environment.
 * @returns The options, or `null` when no DSN is configured.
 */
export function errorMonitoringInit(build: ErrorMonitoringBuild): BrowserOptions | null {
  if (build.dsn === undefined || build.dsn === '') return null;
  return {
    dsn: build.dsn,
    environment: errorMonitoringEnvironmentName(build.mode) ?? 'development',
    release: errorMonitoringRelease(build.version),
    dataCollection: errorMonitoringDataCollection(),
    beforeSend: dropBrowserNoise,
  };
}
