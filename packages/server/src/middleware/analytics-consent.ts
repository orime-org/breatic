// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Open the request's analytics consent context from the browser's cookie.
 *
 * The page writes `breatic_consent` on the site's parent domain, so it rides
 * along with API calls, SSE streams and agent chat requests alike; reading it
 * here covers all three without each client attaching anything (inner#1442
 * design §4.4.5).
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { runWithConsent } from "@breatic/core";
import { CONSENT_COOKIE_NAME, parseConsentCookie } from "@breatic/shared";

/**
 * Put the requesting browser's consent in scope for the rest of the request:
 * each category as its cookie says, with this request's GPC refusing a
 * regional ads default and leaving the visitor's own choice as it is
 * (inner#1442 design §4.4.5). The cookie is read once here; later steps take
 * it from `currentConsent` and `currentAdsBrowser`.
 * @param c - The request context.
 * @param next - The rest of the chain.
 * @returns The chain's response.
 */
export const analyticsConsentMiddleware: MiddlewareHandler = (c, next) => {
  const consent = parseConsentCookie(getCookie(c, CONSENT_COOKIE_NAME), Date.now(), c.req.header("Sec-GPC") === "1");
  return runWithConsent(consent, next, { ads: { consent: consent.ads } });
};
