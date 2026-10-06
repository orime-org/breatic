// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the web build, the backend services and the ingest Worker hand their
 * error monitoring in common.
 *
 * One Sentry release spans all three projects only when each reports the same
 * commit, and a filter on `production` catches all of them only when each uses
 * the same names — so the checks on both live here, once.
 */

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The environment names every project reports under. */
export const ERROR_MONITORING_ENVIRONMENTS = ["production", "staging", "development"] as const;

/** One of {@link ERROR_MONITORING_ENVIRONMENTS}. */
export type ErrorMonitoringEnvironment = (typeof ERROR_MONITORING_ENVIRONMENTS)[number];

/**
 * The release an event carries: the full commit a build was made from.
 *
 * Builds made outside the release pipeline carry a placeholder such as
 * `unknown`; those, and anything else that is not a full lowercase hash, yield
 * nothing, so their events carry no release rather than a shared placeholder.
 * @param value - The commit the build recorded, as read from its carrier.
 * @returns The commit hash, or `undefined`.
 */
export function errorMonitoringRelease(value: unknown): string | undefined {
  return typeof value === "string" && FULL_COMMIT.test(value) ? value : undefined;
}

/**
 * Narrow a configured environment name to one of the shared names.
 * @param value - The configured name.
 * @returns The name, or `undefined` when it is not one of the shared ones.
 */
export function errorMonitoringEnvironmentName(value: unknown): ErrorMonitoringEnvironment | undefined {
  return ERROR_MONITORING_ENVIRONMENTS.find((name) => name === value);
}

/**
 * Header names whose values identify a person or a network path, or carry a
 * credential the SDKs' own list does not name: the ingest Worker's signed
 * `x-upload-ticket` and Stripe's `stripe-signature`.
 */
const IDENTIFYING_HEADERS: readonly string[] = [
  "forwarded",
  "-ip",
  "remote-",
  "via",
  "-user",
  "ticket",
  "signature",
];

/** The data-collection settings, in the shape the Sentry SDKs accept. */
export interface ErrorMonitoringDataCollection {
  userInfo: boolean;
  cookies: boolean;
  httpHeaders: { request: { deny: string[] }; response: { deny: string[] } };
  httpBodies: never[];
  urlQueryParams: boolean;
  genAI: { inputs: boolean; outputs: boolean };
  databaseQueryData: boolean;
  graphQL: { document: boolean; variables: boolean };
}

/**
 * What an SDK may collect on its own, built fresh for each caller.
 *
 * Version 11 collects everything when this is left unset; this is the
 * restrictive baseline from Sentry's v10→v11 migration guide with query
 * strings switched off as well, because some of our links carry tokens in the
 * query.
 * @returns A new settings object.
 */
export function errorMonitoringDataCollection(): ErrorMonitoringDataCollection {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: [...IDENTIFYING_HEADERS] },
      response: { deny: [...IDENTIFYING_HEADERS] },
    },
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    graphQL: { document: false, variables: false },
  };
}
