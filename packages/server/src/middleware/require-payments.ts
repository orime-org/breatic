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
 * moved.
 */

import type { MiddlewareHandler } from "hono";
import { env, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * Throw when this deployment sells nothing.
 * @throws {NotFoundError} When payments are switched off.
 */
export function assertPaymentsEnabled(): void {
  if (!env.PAYMENT_ENABLED) {
    throw new NotFoundError(t("server.membership.unavailable"));
  }
}

/**
 * The same test as a middleware, for routes that gate the whole handler.
 * @param _c - The request context, unused.
 * @param next - The handler behind the gate.
 * @returns Its result.
 * @throws {NotFoundError} When payments are switched off.
 */
export const requirePayments: MiddlewareHandler = (_c, next) => {
  assertPaymentsEnabled();
  return next();
};
