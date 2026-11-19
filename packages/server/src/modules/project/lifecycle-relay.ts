// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transactional-outbox relay for project-lifecycle commands.
 *
 * Polls the `project_lifecycle_outbox` table for unsent rows and
 * forwards each to the durable `project-lifecycle` Redis Stream, one row per
 * transaction (`forwardNextUnsent`), so several server instances can run it
 * at once without two of them publishing the same row. At-least-once: a row is marked
 * sent in the transaction that published it, so a crash between the publish
 * and the commit re-publishes it (collab's copy is idempotent on its canvas
 * documents). A failed
 * publish bumps the attempt counter and leaves the row unsent for the next
 * pass.
 *
 * Started by the server composition root after listen, stopped on
 * SIGTERM. Application-layer: it logs + drives the Redis publish, while
 * the stream key + publish helper stay in core (single source of truth
 * shared with collab's consumer).
 */

import {
  getStreamRedis,
  lifecycleStreamKey,
  logger,
  publishToStream,
  startRelayLoop,
  type RelayLoop,
  type RelayLoopEvent,
} from "@breatic/core";
import { forwardNextUnsent } from "@server/modules/project/lifecycle-outbox.repo.js";

/** How often the relay scans the outbox for unsent rows. */
const POLL_INTERVAL_MS = 1000;
/** Max rows drained per scan (keeps a backlog burst bounded per tick). */
const BATCH_SIZE = 50;

/** Handle to stop the relay loop on shutdown. */
export type LifecycleRelay = RelayLoop;

/**
 * Log one relay event.
 * @param event - What the loop saw.
 */
function report(event: RelayLoopEvent): void {
  switch (event.kind) {
    case "forward_failed":
    case "dead_lettered":
      logger.error({ err: event.err, outboxId: event.id }, "lifecycle_relay_forward_failed");
      return;
    case "pass_failed":
      logger.error({ err: event.err }, "lifecycle_relay_poll_failed");
  }
}

/**
 * Start the outbox relay loop (core's `startRelayLoop`); the first pass runs
 * immediately.
 * @returns A handle whose `stop()` halts the loop
 */
export function startLifecycleRelay(): LifecycleRelay {
  const redis = getStreamRedis();
  return startRelayLoop({
    forwardNext: () =>
      forwardNextUnsent((event) =>
        publishToStream(redis, lifecycleStreamKey(), event as unknown as Record<string, unknown>).then(() => undefined),
      ),
    intervalMs: POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    report,
  });
}
