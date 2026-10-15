// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent snapshot of the browser behind the current request.
 *
 * The server's consent middleware opens this context from the
 * `breatic_consent` cookie, the same way the locale middleware opens the
 * locale context, so a service deep in the call stack can ask whether the
 * request it serves may be measured without the choice being threaded through
 * every signature (inner#1442 design §4.4.5).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { NO_ADS_BROWSER, NO_CONSENT, type BrowserAdsSnapshot, type ConsentSnapshot } from "@breatic/shared";

/** What a request's browser says beyond its consent snapshot. */
export interface RequestBrowser {
  /** Its ads consent, with this request's GPC applied. */
  readonly ads: BrowserAdsSnapshot;
}

const store = new AsyncLocalStorage<{ consent: ConsentSnapshot; browser: RequestBrowser | null }>();

/**
 * Run a request with the given consent in scope.
 * @param consent - The browser's choice, already parsed.
 * @param fn - The request handler.
 * @param browser - The rest of what the browser says, for ad conversions
 *   (inner#1442 design §4.4.5); absent where the caller has no cookie to read.
 * @returns Whatever the handler returns.
 */
export function runWithConsent<T>(consent: ConsentSnapshot, fn: () => T, browser: RequestBrowser | null = null): T {
  return store.run({ consent, browser }, fn);
}

/**
 * The consent of the request being served.
 * @returns The snapshot in scope; {@link NO_CONSENT} outside any request.
 */
export function currentConsent(): ConsentSnapshot {
  return store.getStore()?.consent ?? NO_CONSENT;
}

/**
 * The ads side of the requesting browser's consent.
 * @returns The snapshot in scope; outside a request, or where none was read,
 *   a browser with no choice, which never allows ads.
 */
export function currentAdsBrowser(): BrowserAdsSnapshot {
  return store.getStore()?.browser?.ads ?? NO_ADS_BROWSER;
}
