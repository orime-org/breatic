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
import { currentAdsBrowser, currentConsentSeen, logger, recordSignedInRequest, runWithConsent } from "@breatic/core";
import { CONSENT_COOKIE_NAME, consentSeenFrom, parseConsentChoices, snapshotOf } from "@breatic/shared";

/**
 * Put the requesting browser's consent in scope for the rest of the request:
 * analytics as its cookie says, and for ads the cookie's value with whether
 * this request carried GPC, which ad conversions weigh with the account's
 * switch (inner#1442 design §4.4.5). The cookie is read once here; later
 * steps take it from `currentConsent`, `currentAdsBrowser` and `currentConsentSeen`.
 * @param c - The request context.
 * @param next - The rest of the chain.
 * @returns The chain's response.
 */
export const analyticsConsentMiddleware: MiddlewareHandler = (c, next) => {
  const choices = parseConsentChoices(getCookie(c, CONSENT_COOKIE_NAME), Date.now());
  const consent = snapshotOf(choices);
  const browser = { ads: { consent: consent.ads, gpc: c.req.header("Sec-GPC") === "1" }, seen: consentSeenFrom(choices) };
  return runWithConsent(consent, next, browser);
};

/**
 * Record what a signed-in request says about the account (inner#1442 design
 * §4.4.6): GPC closes its ad switch, and the cookie's choices become the ones
 * last seen. Awaited before the handler runs, so a GPC opt-out is in place for
 * whatever the request does; a failure is logged and the request carries on,
 * since the request's own snapshot already holds GPC.
 * @param userId - The signed-in account.
 */
export async function recordRequestOnAccount(userId: string): Promise<void> {
  try {
    await recordSignedInRequest(userId, { gpc: currentAdsBrowser().gpc, seen: currentConsentSeen() });
  } catch (err) {
    logger.error({ err, userId }, "signed_in_consent_record_failed");
  }
}
