// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The `timeline` queue the server adds an accepted execution's job to, opened on first use: a module that opens it at
 * import needs the core configuration before anything that merely imports it has set it up.
 */

import { createQueue } from "@breatic/core";
import { TIMELINE_QUEUE } from "@breatic/domain";

let queue: ReturnType<typeof createQueue> | undefined;

/**
 * The `timeline` queue, opened once.
 * @returns The queue.
 * @throws {Error} When the queue's Redis configuration cannot be read.
 */
export function timelineQueue(): ReturnType<typeof createQueue> {
  queue ??= createQueue(TIMELINE_QUEUE);
  return queue;
}
