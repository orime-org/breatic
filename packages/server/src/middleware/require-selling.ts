// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refuses the endpoints that only exist where this deployment sells something,
 * which is where a billing service is configured (`COMMERCE_API_URL`,
 * inner#1993 §6.1).
 *
 * A `404` rather than a `403`: on a self-hosted install these endpoints are
 * not a feature that exists, and saying "forbidden" would imply they might
 * work for somebody else.
 *
 * Both the membership and the credit legs gate on this, so the test lives in
 * one place: a second copy would be a second answer the day the flag's meaning
 * moved. What each leg says is its own — a buyer who asked to top up and is
 * told memberships are unavailable has been answered about something else.
 */

import type { MiddlewareHandler } from "hono";
import { env, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * Refuse with this leg's own sentence when the deployment sells nothing.
 * @param message - What to tell the caller, already in their language.
 * @throws {NotFoundError} When nothing is sold here.
 */
function refuseWhenNotSelling(message: string): void {
  if (!env.SELLING) {
    throw new NotFoundError(message);
  }
}

/**
 * Refuse the membership endpoints when this deployment sells nothing.
 * @param _c - The request context, unused.
 * @param next - The handler behind the gate.
 * @returns Its result.
 * @throws {NotFoundError} When nothing is sold here.
 */
export const requireSellingMemberships: MiddlewareHandler = (_c, next) => {
  refuseWhenNotSelling(t("server.membership.unavailable"));
  return next();
};

/**
 * Refuse the credit endpoints when this deployment sells nothing.
 * @param _c - The request context, unused.
 * @param next - The handler behind the gate.
 * @returns Its result.
 * @throws {NotFoundError} When nothing is sold here.
 */
export const requireSelling: MiddlewareHandler = (_c, next) => {
  refuseWhenNotSelling(t("server.payment.unavailable"));
  return next();
};
