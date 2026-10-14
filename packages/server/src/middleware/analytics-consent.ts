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

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { adsOwnership, logger, recordGpcSignal, runWithConsent } from "@breatic/core";
import {
  browserSuppressesOwnGpc,
  CONSENT_COOKIE_NAME,
  parseConsentChoices,
  parseConsentCookie,
} from "@breatic/shared";

/**
 * Put the requesting browser's consent in scope for the rest of the request:
 * analytics as its cookie says, and for ads the cookie's choice with whether
 * this request carried GPC, which ad conversions weigh with the account's
 * events (inner#1442 design §4.4.5).
 * @param c - The request context.
 * @param next - The rest of the chain.
 * @returns The chain's response.
 */
export const analyticsConsentMiddleware: MiddlewareHandler = (c, next) => {
  const raw = getCookie(c, CONSENT_COOKIE_NAME);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const adsBrowser = {
    choice: parseConsentChoices(raw, now).ads,
    gpcAt: c.req.header("Sec-GPC") === "1" ? at : null,
    at,
  };
  return runWithConsent(parseConsentCookie(raw, now), next, adsBrowser);
};

/**
 * Record that a signed-in request carried GPC: an ads opt-out for the whole
 * account (inner#1442 design §4.4.6). Left out only when this browser's cookie
 * holds an override saved while it already sent GPC, and that override is not
 * another account's. Awaited before the handler runs; a failure is logged and
 * the request carries on, since the request's own snapshot already holds GPC.
 * @param c - The request context.
 * @param userId - The signed-in account.
 */
export async function recordRequestGpc(c: Context, userId: string): Promise<void> {
  try {
    const ads = parseConsentChoices(getCookie(c, CONSENT_COOKIE_NAME), Date.now()).ads;
    // Only such an override can be exempt, so no other cookie needs the ownership lookup.
    const exempt =
      browserSuppressesOwnGpc(ads, "none") && browserSuppressesOwnGpc(ads, await adsOwnership(userId, ads?.decisionId));
    if (!exempt) await recordGpcSignal(userId);
  } catch (err) {
    logger.error({ err, userId }, "gpc_signal_record_failed");
  }
}
