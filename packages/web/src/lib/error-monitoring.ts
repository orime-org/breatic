// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getClient, type Breadcrumb, type BrowserOptions, type ErrorEvent } from '@sentry/react';
import {
  addressWithoutQuery,
  errorMonitoringDataCollection,
  errorMonitoringEnvironmentName,
  errorMonitoringRelease,
  requestWithoutQuery,
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

/** Breadcrumb fields that hold an address. */
const ADDRESS_FIELDS: readonly string[] = ['url', 'from', 'to'];

/**
 * Drop an event whose message is browser noise, and strip the query from the
 * page address and the referring page it carries.
 * @param event - The event about to be sent.
 * @returns The event to send, or `null` to drop it.
 */
function prepareEvent(event: ErrorEvent): ErrorEvent | null {
  const message = event.exception?.values?.[0]?.value ?? '';
  if (IGNORED_ERRORS.some((ignored) => message.includes(ignored))) return null;
  return requestWithoutQuery(event);
}

/**
 * Strip the query from the addresses a navigation, fetch or xhr breadcrumb
 * records.
 * @param breadcrumb - The breadcrumb about to be kept.
 * @returns The breadcrumb to keep.
 */
function prepareBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.data === undefined) return breadcrumb;
  return {
    ...breadcrumb,
    data: Object.fromEntries(
      Object.entries(breadcrumb.data).map(([field, value]) => [
        field,
        ADDRESS_FIELDS.includes(field) && typeof value === 'string' ? addressWithoutQuery(value) : value,
      ]),
    ),
  };
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
    beforeSend: prepareEvent,
    beforeBreadcrumb: prepareBreadcrumb,
  };
}

/**
 * Hide synthetic event identifiers when no enabled reporting client exists.
 * @param eventId - Identifier returned by an SDK capture.
 * @returns The identifier for an enabled configured client, otherwise undefined.
 * @throws {Error} If the SDK cannot inspect its client.
 */
export function configuredErrorEventId(eventId: string): string | undefined {
  const client = getClient();
  return client?.getDsn() && client.getOptions().enabled !== false ? eventId : undefined;
}
