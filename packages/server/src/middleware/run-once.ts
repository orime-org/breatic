// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product's run-once middleware: core's run-once over the product's
 * Redis and `config/idempotency.yaml`, its events logged here.
 */

import { createRunOnce, env, getRedis, logger, type RunOnceEvent } from "@breatic/core";
import { getRunningLeaseMs } from "@server/config/idempotency.js";

/**
 * Log one run-once event.
 * @param event - What run-once saw.
 */
function report(event: RunOnceEvent): void {
  const { kind, ...rest } = event;
  if (kind === "renew_failed") logger.warn(rest, "idempotency_renew_failed");
  else logger.error(rest, `idempotency_${kind}`);
}

export const runOnce = createRunOnce({
  redis: getRedis,
  keyPrefix: () => env.REDIS_KEY_PREFIX,
  leaseMs: getRunningLeaseMs,
  report,
});
