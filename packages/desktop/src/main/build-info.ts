// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a build carries besides its brand (inner#2041, design 9.4), written in at
 * build time by tsup: the Sentry DSN every brand reports to, and the commit
 * the build was made from.
 */

/** Build-time values. */
export interface BuildInfo {
  /** Our official Sentry DSN; empty in a development build. */
  sentryDsn: string;
  /** The commit the build was made from, or `unknown` outside CI. */
  commit: string;
}

declare const __BUILD__: BuildInfo;

/** This build's values. */
export const BUILD: BuildInfo = __BUILD__;
