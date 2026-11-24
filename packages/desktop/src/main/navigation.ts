// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a page's navigations and new windows go (inner#2041, design §7).
 *
 * Only the app's own pages stay in the client. The official deployment serves
 * its marketing pages from the same origin, so the path decides, through the
 * prefixes shared with web. Stripe's hosted pages run in the window, so a
 * payment returns to the signed-in client.
 */

import { ASSET_DOWNLOAD_PARAM, isAppPath } from "@breatic/shared";

/** What to do with a navigation of the window. */
export type NavigationDecision = "allow" | "external" | "deny";

/** What to do with a request for a new window. */
export type WindowOpenDecision = "download" | "window" | "external" | "deny";

/**
 * Parse a URL, or null.
 * @param raw - The address.
 * @returns The URL, or null when it does not parse.
 */
function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Whether a URL is a Stripe-hosted page over HTTPS.
 * @param url - The URL.
 * @returns True for stripe.com and its subdomains.
 */
function isStripe(url: URL | null): boolean {
  return url !== null && url.protocol === "https:" && (url.hostname === "stripe.com" || url.hostname.endsWith(".stripe.com"));
}

/**
 * Whether a URL is one of the app's pages on the server.
 * @param url - The URL.
 * @param serverOrigin - The server the client opened.
 * @returns True for an app path on the server's origin.
 */
function isAppPage(url: URL, serverOrigin: string): boolean {
  return url.origin === serverOrigin && isAppPath(url.pathname);
}

/**
 * Decide a navigation of the window's main frame.
 * @param nav - The navigation.
 * @param nav.url - Where it goes.
 * @param nav.currentUrl - Where the window is now.
 * @param nav.serverOrigin - The server the client opened.
 * @returns Stay in the window, hand to the system, or drop.
 */
export function decideNavigation(nav: { url: string; currentUrl: string; serverOrigin: string }): NavigationDecision {
  const url = parse(nav.url);
  if (!url) return "deny";
  if (url.protocol === "mailto:") return "external";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "deny";
  if (isAppPage(url, nav.serverOrigin)) return "allow";
  if (isStripe(url)) return "allow";
  // The window only ever leaves the server for Stripe, so a window already off
  // the server is in a payment; a payment method that leaves Stripe (PayPal,
  // Klarna) stays in the window until it returns to the server.
  const current = parse(nav.currentUrl);
  const inPayment = current !== null && current.protocol === "https:" && current.origin !== nav.serverOrigin;
  if (inPayment && url.protocol === "https:") return "allow";
  return "external";
}

/**
 * Decide a request for a new window (`window.open`, `target=_blank`).
 * @param open - The request.
 * @param open.url - The address asked for.
 * @param open.serverOrigin - The server the client opened.
 * @returns Download in the client, open a client window, hand to the system, or drop.
 */
export function decideWindowOpen(open: { url: string; serverOrigin: string }): WindowOpenDecision {
  const url = parse(open.url);
  if (!url) return "deny";
  if (url.protocol === "mailto:") return "external";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "deny";
  if (url.searchParams.get(ASSET_DOWNLOAD_PARAM) === "1") return "download";
  if (isAppPage(url, open.serverOrigin)) return "window";
  return "external";
}

/** Chromium's code for a load cancelled by the client itself (a refused navigation, a download). */
const ERR_ABORTED = -3;

/**
 * Whether a failed load means the server cannot be reached.
 * @param failure - The `did-fail-provisional-load` details (Chromium committed an error entry).
 * @param failure.url - What was loading.
 * @param failure.serverOrigin - The server the client opened.
 * @param failure.isMainFrame - Whether it was the page itself.
 * @param failure.errorCode - Chromium's error code.
 * @returns True for a main-frame load of the server that failed for a reason other than cancelling.
 */
export function isServerLoadFailure(failure: { url: string; serverOrigin: string; isMainFrame: boolean; errorCode: number }): boolean {
  const url = parse(failure.url);
  return failure.isMainFrame && failure.errorCode !== ERR_ABORTED && url !== null && url.origin === failure.serverOrigin;
}

/**
 * Whether a Chromium error code is a certificate error (`net::ERR_CERT_*` spans -200 to -299).
 * @param errorCode - Chromium's error code.
 * @returns True for a certificate error.
 */
export function isCertificateError(errorCode: number): boolean {
  return errorCode <= -200 && errorCode > -300;
}

/** The part of a window's `navigationHistory` that Back and Forward use. */
export interface HistorySteps {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
}

/**
 * Go back or forward in a window's history, from the menu or a Windows app
 * command. The mouse's side buttons need nothing: Chromium goes back and
 * forward when a page releases them, as in Chrome.
 * @param history - The focused window's history, if there is a window.
 * @param direction - Which way.
 */
export function stepHistory(history: HistorySteps | undefined, direction: "back" | "forward"): void {
  if (direction === "back" && history?.canGoBack()) history.goBack();
  if (direction === "forward" && history?.canGoForward()) history.goForward();
}

/**
 * Which way a Windows app command (`WM_APPCOMMAND`: a Browser Back or Forward
 * key, or a mouse button its driver maps to one) steps the history. Chrome
 * handles these in its browser window (`BrowserView::ExecuteWindowsCommand`);
 * the page never sees them.
 * @param command - The `app-command` name.
 * @returns The direction, or null for any other command.
 */
export function appCommandDirection(command: string): "back" | "forward" | null {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}
