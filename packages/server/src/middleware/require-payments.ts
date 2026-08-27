// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Refuses the endpoints that only exist where this deployment sells something.
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
 * @throws {NotFoundError} When payments are switched off.
 */
function refuseWhenNotSelling(message: string): void {
  if (!env.PAYMENT_ENABLED) {
    throw new NotFoundError(message);
  }
}

/**
 * Throw on the membership endpoints when this deployment sells nothing.
 * @throws {NotFoundError} When payments are switched off.
 */
export function assertPaymentsEnabled(): void {
  refuseWhenNotSelling(t("server.membership.unavailable"));
}

/**
 * The same test as a middleware, for the credit endpoints.
 * @param _c - The request context, unused.
 * @param next - The handler behind the gate.
 * @returns Its result.
 * @throws {NotFoundError} When payments are switched off.
 */
export const requirePayments: MiddlewareHandler = (_c, next) => {
  refuseWhenNotSelling(t("server.payment.unavailable"));
  return next();
};
