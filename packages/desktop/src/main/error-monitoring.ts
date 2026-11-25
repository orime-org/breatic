// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The shell's error monitoring (inner#2041, design 9.4). Every brand reports to
 * our official Sentry project with the DSN written in at build time, tagged
 * with the brand: errors, crashes and a session record per launch (release
 * health, which Sentry does not bill). The web pages keep their own Sentry;
 * the shell stays off their sessions and protocols. Kept apart from Electron so the options can be tested.
 */

import {
  addressWithoutQuery,
  errorMonitoringDataCollection,
  errorMonitoringRelease,
  isSentryDsn,
  requestWithoutQuery,
  type ErrorMonitoringDataCollection,
} from "@breatic/shared";

/** `IPCMode.Classic` of `@sentry/electron`: ipcMain channels only, no privileged `sentry-ipc://` scheme. */
const IPC_MODE_CLASSIC = 1;

/**
 * Default integrations the shell drops: preload injection (it would reach the
 * server's pages) and console breadcrumbs (Electron prints full addresses
 * there; logs go through pino).
 */
const DROPPED_INTEGRATIONS = new Set(["PreloadInjection", "Console"]);

/** An http(s) address inside a longer string, up to whitespace or a quote. */
const ADDRESS = /https?:\/\/[^\s'"<>]+/g;

/**
 * The DSN a build carries.
 * @param raw - `BREATIC_DESKTOP_SENTRY_DSN`.
 * @param build - Whether this is a release build (tagged CI or a partner pipeline).
 * @param build.release - True for a release build.
 * @returns The DSN, or empty for a development build without one.
 * @throws {Error} When a release build has none, or any build has a malformed one.
 */
export function buildTimeSentryDsn(raw: string | undefined, build: { release: boolean }): string {
  const dsn = raw?.trim() ?? "";
  if (dsn === "") {
    if (build.release) throw new Error("BREATIC_DESKTOP_SENTRY_DSN is required for a release build");
    return "";
  }
  if (!isSentryDsn(dsn)) throw new Error("BREATIC_DESKTOP_SENTRY_DSN is not a Sentry DSN");
  return dsn;
}

/**
 * The commit a build carries, its Sentry release.
 * @param raw - `GITHUB_SHA`.
 * @param build - Whether this is a release build.
 * @param build.release - True for a release build.
 * @returns The commit, or `unknown` for a development build without one.
 * @throws {Error} When a release build has no full commit hash: Sentry keeps no session without a release, and source maps are uploaded under it.
 */
export function buildTimeCommit(raw: string | undefined, build: { release: boolean }): string {
  const commit = raw?.trim() ?? "";
  if (errorMonitoringRelease(commit) !== undefined) return commit;
  if (build.release) throw new Error("GITHUB_SHA must be the full commit hash for a release build");
  return "unknown";
}

/** The options the shell hands `@sentry/electron/main`'s `init`, beside its integrations and hooks. */
export interface DesktopSentryOptions {
  dsn: string;
  environment: "production" | "development";
  release: string | undefined;
  ipcMode: number;
  attachScreenshot: false;
  dataCollection: ErrorMonitoringDataCollection;
  initialScope: { tags: { brand: string } };
}

/**
 * The shell's Sentry options.
 * @param build - What the build carries.
 * @param build.dsn - The DSN written in at build time.
 * @param build.brandId - The brand id, tagged on every event.
 * @param build.packaged - `app.isPackaged`.
 * @param build.commit - The commit the build was made from.
 * @returns The options, or null when the build carries no DSN.
 */
export function desktopSentryOptions(build: { dsn: string; brandId: string; packaged: boolean; commit: string }): DesktopSentryOptions | null {
  if (build.dsn === "") return null;
  return {
    dsn: build.dsn,
    environment: build.packaged ? "production" : "development",
    release: errorMonitoringRelease(build.commit),
    ipcMode: IPC_MODE_CLASSIC,
    attachScreenshot: false,
    dataCollection: errorMonitoringDataCollection(),
    initialScope: { tags: { brand: build.brandId } },
  };
}

/**
 * Whether a default integration stays.
 * @param name - The integration's name.
 * @returns False for the ones the shell drops.
 */
export function keepsIntegration(name: string): boolean {
  return !DROPPED_INTEGRATIONS.has(name);
}

/**
 * A string with every address's query and fragment removed and the home directory written as `~`.
 * @param text - The string.
 * @param home - `app.getPath("home")`.
 * @returns The scrubbed string.
 */
function scrubText(text: string, home: string): string {
  const withoutQueries = text.replace(ADDRESS, (address) => addressWithoutQuery(address));
  return home === "" ? withoutQueries : withoutQueries.split(home).join("~");
}

/**
 * A value with every string in it scrubbed.
 * @param value - Any JSON-like value.
 * @param home - `app.getPath("home")`.
 * @returns A scrubbed copy.
 */
function scrubValue(value: unknown, home: string): unknown {
  if (typeof value === "string") return scrubText(value, home);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, home));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item, home)]));
  }
  return value;
}

/**
 * An event before it is sent: the request through the shared rule, then every
 * address-like string in the exception values, contexts and extra without
 * its query, and the home directory as `~`.
 * @param event - The event.
 * @param home - `app.getPath("home")`.
 * @returns A scrubbed copy.
 */
export function scrubEvent<T extends { request?: { url?: string; headers?: Record<string, string> } }>(event: T, home: string): T {
  return scrubValue(requestWithoutQuery(event), home) as T;
}

/**
 * A breadcrumb before it is kept: its message and data scrubbed like an event.
 * @param breadcrumb - The breadcrumb.
 * @param home - `app.getPath("home")`.
 * @returns A scrubbed copy.
 */
export function scrubBreadcrumb<T extends object>(breadcrumb: T, home: string): T {
  return scrubValue(breadcrumb, home) as T;
}
