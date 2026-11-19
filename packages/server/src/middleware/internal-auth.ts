// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
  switch (event.kind) {
    case "rejected":
      logger.warn({ step: event.step, path: event.path }, "internal_auth_rejected");
      return;
    case "forbidden":
      logger.warn({ signer: event.signer, path: event.path }, "internal_auth_forbidden");
      return;
    case "nonce_unavailable":
      logger.error({ err: event.err }, "internal_nonce_unavailable");
  }
}

export const internalAuth = createInternalAuth({
  secretsFor: () => ({ current: env.INTERNAL_API_SECRET, previous: env.INTERNAL_API_SECRET_PREVIOUS }),
  mayAccess: () => true,
  redis: getRedis,
  keyPrefix: () => env.ENV,
  report,
});
