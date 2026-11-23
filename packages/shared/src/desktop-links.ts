// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Addresses the web app and the desktop client must read the same way (inner#2041).
 *
 * The official deployment serves the marketing site and the app from one
 * origin, routed by path at the edge, so the origin alone cannot tell the
 * desktop client which pages belong in its window.
 */

/** The query the resource domain answers with `Content-Disposition: attachment`. */
export const ASSET_DOWNLOAD_PARAM = "download";

/**
 * The first path segment of every page the app serves. A test in web checks
 * each top-level route in `packages/web/src/app/routes.tsx` against this list.
 */
export const APP_ROUTE_PREFIXES = [
  "/studio",
  "/project",
  "/decision",
  "/choose-slug",
  "/login",
  "/register",
  "/recovery-code",
  "/forgot-password",
  "/reset-password",
  "/desktop",
] as const;

/**
 * Whether a path on our own server is a page of the app.
 * @param pathname - The URL path, starting with `/`.
 * @returns True for a listed prefix itself or anything under it.
 */
export function isAppPath(pathname: string): boolean {
  return APP_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
