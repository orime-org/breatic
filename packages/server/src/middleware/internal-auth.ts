// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product internal listener's authentication: core's signature and nonce
 * checks over `INTERNAL_API_SECRET` (and `_PREVIOUS` during rotation), nonces
 * in the product's Redis, its events logged here.
 */

import { createInternalAuth, env, getRedis, logger, type InternalAuthEvent } from "@breatic/core";

/**
 * Log one authentication event.
 * @param event - What the authentication saw.
 */
function report(event: InternalAuthEvent): void {
  if (event.kind === "rejected") logger.warn({ step: event.step, path: event.path }, "internal_auth_rejected");
  else logger.error({ err: event.err }, "internal_nonce_unavailable");
}

export const internalAuth = createInternalAuth({
  secrets: () => ({ current: env.INTERNAL_API_SECRET, previous: env.INTERNAL_API_SECRET_PREVIOUS }),
  redis: getRedis,
  keyPrefix: () => env.ENV,
  report,
});
