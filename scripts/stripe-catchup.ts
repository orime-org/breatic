// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe catch-up after a stop (inner#1993 §9.5): lists the events the
 * webhook handles from `config/stripe-catchup.yaml`'s lookback before
 * `--since`, skips the processed set and processes the rest the way the
 * webhook does, oldest first. Exits non-zero while any event failed; a rerun
 * skips what succeeded. The process starts and stops the way the server
 * does, so the work a handler starts after it answers (mails, refund
 * reports, ads conversions) finishes and its analytics are sent.
 */

import { findRoot, loadEnv } from "./load-env.js";
import { parseStripeCatchUpOptions } from "./stripe-catchup-options.js";

const options = parseStripeCatchUpOptions(process.argv.slice(2));
if (options.help) {
  console.log("Usage: pnpm stripe:catchup --since <ISO instant with zone, the moment processing stopped>");
} else {
  loadEnv(findRoot());
  const loaded: unknown = await import(new URL("../packages/core/dist/index.js", import.meta.url).href);
  const core = loaded as typeof import("../packages/core/src/index.js");
  core.initCore(process.env);
  core.initLogger("stripe-catchup");
  core.loadLocales();
  const analytics = core.initServerAnalytics({
    apiKey: core.env.AMPLITUDE_API_KEY,
    onError: (message) => core.logger.warn({ message }, "analytics_events_rejected"),
  });
  if (analytics === "invalid") core.logger.error({}, "amplitude_api_key_invalid");
  const { catchUpStripeEvents, handleLikeWebhook, processedEventIds } = await import("../packages/server/src/modules/stripe-webhook/catch-up.js");
  const { getStripeClient } = await import("../packages/server/src/infra/stripe.js");
  const { getStripeCatchUpLookbackHours } = await import("../packages/server/src/config/stripe-catchup.js");
  const { settleAfterReply } = await import("../packages/server/src/utils/after-reply.js");
  const stripe = getStripeClient();
  try {
    const outcome = await catchUpStripeEvents(
      {
        listEvents: ({ types, createdGte }) => stripe.events.list({ types: [...types], created: { gte: createdGte }, limit: 100 }),
        processedIds: processedEventIds,
        handle: handleLikeWebhook,
        onFailed: (eventId, cause) => core.logger.error({ eventId, ...cause }, "stripe_catchup_event_failed"),
      },
      options.since,
      getStripeCatchUpLookbackHours(),
    );
    core.logger.info({ since: options.since.toISOString(), ...outcome }, "stripe_catchup_finished");
    if (outcome.failed.length > 0) process.exitCode = 1;
  } catch (err) {
    core.logger.error({ err, since: options.since.toISOString() }, "stripe_catchup_failed");
    process.exitCode = 1;
  } finally {
    await settleAfterReply();
    await Promise.allSettled([
      core.flushServerAnalytics(),
      core.closeDb(),
      core.closeRedis(),
      core.closeQueueRedis(),
      core.closeQueues(),
    ]);
  }
}
