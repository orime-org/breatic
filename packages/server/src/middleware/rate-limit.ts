// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product's rate limiters: core's limiter over the product's
 * `config/rate-limits.yaml`, counted in the product's Redis, its events
 * logged here. Every route throttles through `rateLimitFor` or
 * `rateLimitForAll` from this file.
 */

import { checkRateLimit, createRateLimiting, getRedis, logger, type RateLimitEvent } from "@breatic/core";
import { getRateLimit } from "@server/config/rate-limits.js";

/**
 * Log one limiter event.
 * @param event - What the limiter saw.
 */
function report(event: RateLimitEvent): void {
  switch (event.kind) {
    case "client_unidentified":
      logger.error(
        { actions: event.actions, reason: event.reason, peerAddress: event.peerAddress },
        "rate_limit_client_unidentified",
      );
      return;
    case "unavailable":
      logger.error({ err: event.err, actions: event.actions }, "rate_limit_unavailable");
      return;
    case "hit":
      logger.warn({ actions: event.actions, keys: event.keys }, "rate_limit_hit");
  }
}

export const { rateLimit, rateLimitFor, rateLimitForAll } = createRateLimiting({
  count: (quotas) => checkRateLimit(getRedis(), quotas),
  report,
  limitOf: getRateLimit,
});
