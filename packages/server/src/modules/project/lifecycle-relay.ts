// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Transactional-outbox relay for project-lifecycle commands.
 *
 * Polls the `project_lifecycle_outbox` table for unsent rows and
 * forwards each to the durable `project-lifecycle` Redis Stream, then
 * marks it sent. At-least-once: a row is marked sent only AFTER a
 * successful publish, so a crash between publish and mark re-publishes
 * it (collab's consumer is idempotent). A failed publish bumps the
 * attempt counter and leaves the row unsent for the next pass.
 *
 * Started by the server composition root after listen, stopped on
 * SIGTERM. Application-layer: it logs + drives the Redis publish, while
 * the stream key + publish helper stay in core (single source of truth
 * shared with collab's consumer).
 */

import { getStreamRedis, lifecycleStreamKey, publishToStream, logger } from "@breatic/core";
import {
  bumpAttempts,
  markSent,
  readUnsentEvents,
} from "@server/modules/project/lifecycle-outbox.repo.js";

/** How often the relay scans the outbox for unsent rows. */
const POLL_INTERVAL_MS = 1000;
/** Max rows drained per scan (keeps a backlog burst bounded per tick). */
const BATCH_SIZE = 50;

/** Handle to stop the relay loop on shutdown. */
export interface LifecycleRelay {
  /** Stop polling; in-flight publishes settle, no new pass is scheduled. */
  stop(): void;
}

/**
 * Start the outbox relay loop.
 *
 * Self-scheduling (a new pass is queued only after the previous one
 * settles) so a slow batch can never overlap itself. The first pass
 * runs immediately.
 * @returns A handle whose `stop()` halts the loop
 */
export function startLifecycleRelay(): LifecycleRelay {
  const redis = getStreamRedis();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** One drain pass: forward every unsent row, then re-arm the timer. */
  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const rows = await readUnsentEvents(BATCH_SIZE);
      for (const row of rows) {
        if (stopped) break;
        try {
          await publishToStream(
            redis,
            lifecycleStreamKey(),
            row.event as unknown as Record<string, unknown>,
          );
          await markSent(row.id);
        } catch (err) {
          logger.error({ err, outboxId: row.id }, "lifecycle_relay_forward_failed");
          await bumpAttempts(row.id);
        }
      }
    } catch (err) {
      logger.error({ err }, "lifecycle_relay_poll_failed");
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
  }

  void tick();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
