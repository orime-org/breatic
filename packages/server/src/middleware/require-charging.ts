// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Refuses the endpoints that only exist where this deployment records and
 * deducts credits (`CHARGING_ENABLED`, inner#1993 §6.1), such as a Studio's
 * spend limits. A deployment that charges without selling has them too.
 *
 * A `404`, like `requireSelling`: where credits are not charged these
 * endpoints are not a feature that exists.
 */

import type { MiddlewareHandler } from "hono";
import { env, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * Refuse the request when this deployment charges no credits.
 * @param _c - The request context, unused.
 * @param next - The handler behind the gate.
 * @returns Its result.
 * @throws {NotFoundError} When credits are not charged here.
 */
export const requireCharging: MiddlewareHandler = (_c, next) => {
  if (!env.CHARGING_ENABLED) throw new NotFoundError(t("server.payment.unavailable"));
  return next();
};
